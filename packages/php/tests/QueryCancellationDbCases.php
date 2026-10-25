<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use Pdo\Sqlite;
use Polyspec\Orm\Cancellation;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

/**
 * The cancellation cases of a statement on a PostgreSQL or MySQL server, shared by the PHP library and the extension:
 * a cancelled statement rolls back its transaction and the root connection stays usable.
 */
trait QueryCancellationDbCases
{
    /** The state file of a new Cancellation is private and follows begin (1), cancel (3) and end (2). */
    private static function assertCancellationStateTransitions(Cancellation $cancellation, string $path): void
    {
        clearstatcache(true, $path);
        self::assertSame(0600, fileperms($path) & 0777);
        self::assertSame("\0", file_get_contents($path));
        $cancellation->begin();
        self::assertSame("\1", file_get_contents($path));
        $cancellation->cancel();
        self::assertSame("\3", file_get_contents($path));
        $cancellation->end();
        self::assertSame("\2", file_get_contents($path));
    }

    /** The cancelled transaction left no row of cancellation_rollback, and the root $root still answers. */
    private static function assertRolledBackAndUsable(Db $root): void
    {
        self::assertSame([[0]], $root->fetch(
            'select',
            ['cancellation_rollback'],
            null,
            'SELECT count(*) FROM cancellation_rollback'
        ));
        self::assertSame([[1]], $root->fetch('select', [], null, 'SELECT 1'));
    }

    /** A cancel-query callback that counts its calls in $calls. */
    private static function countingCancelQuery(int &$calls): \Closure
    {
        return static function () use (&$calls): void {
            $calls++;
        };
    }

    /**
     * Runs, in a transaction of $root that inserts a row of $table, a recursive SQLite query through $cancelled whose
     * collation $collation of $pdo cancels $cancellation on its first comparison; the transaction must fail with
     * CANCELED and roll back the row.
     */
    private static function assertSqliteQueryCancelled(
        \PDO $pdo,
        Db $root,
        Db $cancelled,
        Cancellation $cancellation,
        string $table,
        string $collation
    ): void {
        $requested = false;
        $pdo->createCollation($collation, static function (
            string $left,
            string $right
        ) use (
            $cancellation,
            &$requested
        ): int {
            if (!$requested) {
                $requested = true;
                $cancellation->cancel();
            }
            return strcmp($left, $right);
        });
        $pdo->exec("CREATE TABLE $table (value INTEGER)");
        try {
            $root->transaction(function () use ($root, $cancelled, $table, $collation): void {
                $root->run('insert', [$table], 1, "INSERT INTO $table (value) VALUES (1)");
                $cancelled->fetch(
                    'select',
                    [],
                    1,
                    "WITH RECURSIVE x(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM x WHERE v<10000) "
                        . "SELECT count(*) FROM x WHERE printf('%08d',v) COLLATE $collation > '99999999'"
                );
                self::fail('the SQLite virtual machine should stop at its progress callback');
            }, retry: 0);
            self::fail('the cancelled transaction should fail');
        } catch (OrmException $error) {
            self::assertSame(Code::CANCELED, $error->code_, $error->getMessage());
            self::assertTrue($requested, 'the cancellation came from a collation inside the active query');
        }
        self::assertSame([[0]], $root->fetch('select', [$table], null, "SELECT count(*) FROM $table"));
    }

    // Requirements: CFG-9.
    public function testPostgresNoticeCancelsActiveStatementRollsBackAndReusesRoot(): void
    {
        with_case_database('postgres', static function (): void {
        }, static function (string $dsn): void {
            $root = Orm::connect($dsn, new Config());
            $source = new Cancellation();
            $cancelled = $root->withCancellation($source);
            $pdo = $root->pdo();
            self::assertInstanceOf(\Pdo\Pgsql::class, $pdo);
            $originalPid = $pdo->getPid();
            $activeNotice = false;
            $pdo->setNoticeCallback(static function (string $notice) use ($source, &$activeNotice): void {
                if (str_contains($notice, 'orm-cancel-active')) {
                    $activeNotice = true;
                    $source->cancel();
                }
            });

            try {
                $root->run(
                    'schema',
                    ['cancellation_rollback'],
                    null,
                    'CREATE TABLE cancellation_rollback (value INTEGER)'
                );
                try {
                    $root->transaction(function () use ($root, $cancelled): void {
                        $root->run(
                            'insert',
                            ['cancellation_rollback'],
                            1,
                            'INSERT INTO cancellation_rollback (value) VALUES (1)'
                        );
                        $cancelled->run(
                            'utility',
                            [],
                            1,
                            "DO \$cancel\$ BEGIN RAISE NOTICE 'orm-cancel-active'; PERFORM pg_sleep(30); END \$cancel\$"
                        );
                        self::fail('the active PostgreSQL statement should be terminated');
                    }, retry: 0);
                    self::fail('the cancelled transaction should fail');
                } catch (OrmException $error) {
                    self::assertSame(Code::CANCELED, $error->code_, $error->getMessage());
                    self::assertTrue($activeNotice, 'the notice callback ran while the statement was active');
                }

                self::assertSame(
                    $originalPid,
                    $root->pdo()->getPid(),
                    'the logical root handle reuses its cancelled backend after rollback'
                );
                self::assertRolledBackAndUsable($root);
            } finally {
                $root->close();
            }
        });
    }

    // Requirements: CFG-9.
    public function testMysqlLockEventCancelsActiveStatementRollsBackAndReconnectsRoot(): void
    {
        self::assertTrue(
            function_exists('pcntl_fork'),
            'the active-query cancellation cases require the pinned CLI PHP with pcntl enabled'
        );
        with_case_database('mysql', static function (): void {
        }, static function (string $dsn): void {
            $root = Orm::connect($dsn, new Config());
            $source = new Cancellation();
            $cancelled = $root->withCancellation($source);
            $idleRoot = Orm::connect($dsn, new Config());
            $idleCancelled = $idleRoot->withCancellation($source);
            $pdo = $root->pdo();
            $idlePdo = $idleRoot->pdo();
            self::assertInstanceOf(\Pdo\Mysql::class, $pdo);
            self::assertInstanceOf(\Pdo\Mysql::class, $idlePdo);
            $originalId = (int) $pdo->query('SELECT CONNECTION_ID()')->fetchColumn();
            $idleOriginalId = (int) $idlePdo->query('SELECT CONNECTION_ID()')->fetchColumn();
            $readyLock = 'orm_cancel_ready_' . bin2hex(random_bytes(8));
            $waitLock = 'orm_cancel_wait_' . bin2hex(random_bytes(8));
            self::assertSame(
                1,
                (int) $pdo->query('SELECT GET_LOCK(' . $pdo->quote($readyLock) . ', 0)')->fetchColumn(),
            );

            $eventPair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, 0);
            $releasePair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, 0);
            self::assertIsArray($eventPair);
            self::assertIsArray($releasePair);
            [$eventRead, $eventWrite] = $eventPair;
            [$releaseRead, $releaseWrite] = $releasePair;
            $child = pcntl_fork();
            self::assertNotSame(-1, $child, 'the active-query controller process must start');
            if ($child === 0) {
                fclose($eventRead);
                fclose($releaseWrite);
                try {
                    $controller = Orm::connect($dsn, new Config());
                    $wait = $controller->fetch('utility', [], null, 'SELECT GET_LOCK(?, 0)', [$waitLock]);
                    if (($wait[0][0] ?? null) != 1) {
                        exit(1);
                    }
                    fwrite($eventWrite, "R");
                    fflush($eventWrite);
                    $controller->fetch('utility', [], null, 'SELECT GET_LOCK(?, 10)', [$readyLock]);
                    $source->cancel();
                    fread($releaseRead, 1);
                    $controller->close();
                    exit(0);
                } catch (\Throwable) {
                    exit(1);
                }
            }

            fclose($eventWrite);
            fclose($releaseRead);

            try {
                self::assertSame('R', fread($eventRead, 1), 'the controller acquired its blocker lock');
                $root->run(
                    'schema',
                    ['cancellation_rollback'],
                    null,
                    'CREATE TABLE cancellation_rollback (value INTEGER)'
                );
                try {
                    $root->transaction(function () use ($root, $cancelled, $waitLock, $readyLock): void {
                        $root->run(
                            'insert',
                            ['cancellation_rollback'],
                            1,
                            'INSERT INTO cancellation_rollback (value) VALUES (1)'
                        );
                        $cancelled->fetch(
                            'select',
                            [],
                            1,
                            'SELECT GET_LOCK(?, IF(RELEASE_LOCK(?) = 1, 10, 0))',
                            [$waitLock, $readyLock]
                        );
                        self::fail('the active MySQL statement should be terminated');
                    }, retry: 0);
                    self::fail('the cancelled transaction should fail');
                } catch (OrmException $error) {
                    self::assertSame(Code::CANCELED, $error->code_, $error->getMessage());
                    self::assertTrue(
                        $source->isCancelled(),
                        'the child cancelled the shared token after the SQL event',
                    );
                }

                self::assertNotSame($originalId, (int) $root->pdo()->query('SELECT CONNECTION_ID()')->fetchColumn());
                self::assertSame(
                    $idleOriginalId,
                    (int) $idleRoot->pdo()->query('SELECT CONNECTION_ID()')->fetchColumn(),
                );
                self::assertRolledBackAndUsable($root);
                self::assertSame([[1]], $idleRoot->fetch('select', [], null, 'SELECT 1'));
            } finally {
                try {
                    $root->fetch('utility', [], null, 'SELECT RELEASE_LOCK(?)', [$readyLock]);
                } finally {
                    fwrite($releaseWrite, "D");
                    fflush($releaseWrite);
                    fclose($releaseWrite);
                    fclose($eventRead);
                    pcntl_waitpid($child, $status);
                    $root->close();
                    $idleRoot->close();
                }
            }
        });
    }

    // Requirements: CFG-9.
    public function testMysqlCancellationStopsEveryActiveRootAndReopensEachProcessRoot(): void
    {
        self::assertTrue(
            function_exists('pcntl_fork'),
            'the active-query cancellation cases require the pinned CLI PHP with pcntl enabled'
        );
        with_case_database('mysql', static function (): void {
        }, static function (string $dsn): void {
            $rootOne = Orm::connect($dsn, new Config());
            $rootTwo = Orm::connect($dsn, new Config());
            $source = new Cancellation();
            $cancelledOne = $rootOne->withCancellation($source);
            $cancelledTwo = $rootTwo->withCancellation($source);
            $originalOne = (int) $rootOne->pdo()->query('SELECT CONNECTION_ID()')->fetchColumn();
            $originalTwo = (int) $rootTwo->pdo()->query('SELECT CONNECTION_ID()')->fetchColumn();
            $readyOne = 'orm_cancel_ready_one_' . bin2hex(random_bytes(8));
            $readyTwo = 'orm_cancel_ready_two_' . bin2hex(random_bytes(8));
            $waitOne = 'orm_cancel_wait_one_' . bin2hex(random_bytes(8));
            $waitTwo = 'orm_cancel_wait_two_' . bin2hex(random_bytes(8));
            self::assertSame(1, (int) $rootOne->pdo()->query(
                'SELECT GET_LOCK(' . $rootOne->pdo()->quote($readyOne) . ', 0)'
            )->fetchColumn());
            self::assertSame(1, (int) $rootTwo->pdo()->query(
                'SELECT GET_LOCK(' . $rootTwo->pdo()->quote($readyTwo) . ', 0)'
            )->fetchColumn());
            $rootOne->run(
                'schema',
                ['cancellation_rollback'],
                null,
                'CREATE TABLE cancellation_rollback (value INTEGER)'
            );

            $eventPair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, 0);
            $resultPair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, 0);
            self::assertIsArray($eventPair);
            self::assertIsArray($resultPair);
            [$eventRead, $eventWrite] = $eventPair;
            [$resultRead, $resultWrite] = $resultPair;
            $controller = pcntl_fork();
            self::assertNotSame(-1, $controller, 'the active-query cancellation process must start');
            if ($controller === 0) {
                fclose($eventRead);
                fclose($resultRead);
                fclose($resultWrite);
                try {
                    $control = Orm::connect($dsn, new Config());
                    foreach ([$waitOne, $waitTwo] as $lock) {
                        $acquired = $control->fetch('utility', [], null, 'SELECT GET_LOCK(?, 0)', [$lock]);
                        if (($acquired[0][0] ?? null) != 1) {
                            exit(1);
                        }
                    }
                    fwrite($eventWrite, 'R');
                    fflush($eventWrite);
                    foreach ([$readyOne, $readyTwo] as $lock) {
                        $released = $control->fetch('utility', [], null, 'SELECT GET_LOCK(?, 10)', [$lock]);
                        if (($released[0][0] ?? null) != 1) {
                            exit(1);
                        }
                    }
                    $source->cancel();
                    $source->cancel();
                    fwrite($eventWrite, 'C');
                    fflush($eventWrite);
                    $control->close();
                    exit(0);
                } catch (\Throwable) {
                    exit(1);
                }
            }

            fclose($eventWrite);
            // The second root's process starts only after the controller holds both wait locks: started earlier, its
            // statement could take the wait lock of the second root first and the controller would stop.
            $held = fread($eventRead, 1);
            $worker = pcntl_fork();
            self::assertNotSame(-1, $worker, 'the second active-query process must start');
            if ($worker === 0) {
                fclose($eventRead);
                fclose($resultRead);
                try {
                    $rootTwo->transaction(function () use (
                        $rootTwo,
                        $cancelledTwo,
                        $waitTwo,
                        $readyTwo
                    ): void {
                        $rootTwo->run(
                            'insert',
                            ['cancellation_rollback'],
                            1,
                            'INSERT INTO cancellation_rollback (value) VALUES (2)'
                        );
                        $cancelledTwo->fetch(
                            'select',
                            [],
                            1,
                            'SELECT GET_LOCK(?, IF(RELEASE_LOCK(?) = 1, 10, 0))',
                            [$waitTwo, $readyTwo]
                        );
                        self::fail('the active second MySQL statement should be terminated');
                    }, retry: 0);
                    exit(1);
                } catch (OrmException $error) {
                    if ($error->code_ !== Code::CANCELED || $source->isCancelled() !== true) {
                        fwrite($resultWrite, '0');
                        fflush($resultWrite);
                        exit(1);
                    }
                } catch (\Throwable) {
                    fwrite($resultWrite, '0');
                    fflush($resultWrite);
                    exit(1);
                }

                try {
                    if ((int) $rootTwo->pdo()->query('SELECT CONNECTION_ID()')->fetchColumn() === $originalTwo) {
                        fwrite($resultWrite, '0');
                        fflush($resultWrite);
                        exit(1);
                    }
                    if (
                        $rootTwo->fetch(
                            'select',
                            ['cancellation_rollback'],
                            null,
                            'SELECT count(*) FROM cancellation_rollback'
                        ) !== [[0]]
                    ) {
                        fwrite($resultWrite, '0');
                        fflush($resultWrite);
                        exit(1);
                    }
                    if ($rootTwo->fetch('select', [], null, 'SELECT 1') !== [[1]]) {
                        fwrite($resultWrite, '0');
                        fflush($resultWrite);
                        exit(1);
                    }
                    fwrite($resultWrite, '1');
                    fflush($resultWrite);
                    $rootTwo->close();
                    exit(0);
                } catch (\Throwable) {
                    fwrite($resultWrite, '0');
                    fflush($resultWrite);
                    exit(1);
                }
            }

            fclose($resultWrite);
            $workerStatus = 0;
            $controllerStatus = 0;
            try {
                self::assertSame('R', $held, 'both blocker locks are held before the active queries');
                try {
                    $rootOne->transaction(function () use ($rootOne, $cancelledOne, $waitOne, $readyOne): void {
                        $rootOne->run(
                            'insert',
                            ['cancellation_rollback'],
                            1,
                            'INSERT INTO cancellation_rollback (value) VALUES (1)'
                        );
                        $cancelledOne->fetch(
                            'select',
                            [],
                            1,
                            'SELECT GET_LOCK(?, IF(RELEASE_LOCK(?) = 1, 10, 0))',
                            [$waitOne, $readyOne]
                        );
                        self::fail('the active first MySQL statement should be terminated');
                    }, retry: 0);
                    self::fail('the first cancelled transaction should fail');
                } catch (OrmException $error) {
                    self::assertSame(Code::CANCELED, $error->code_, $error->getMessage());
                    self::assertTrue($source->isCancelled());
                }

                self::assertNotSame(
                    $originalOne,
                    (int) $rootOne->pdo()->query('SELECT CONNECTION_ID()')->fetchColumn(),
                );
                self::assertSame([[0]], $rootOne->fetch(
                    'select',
                    ['cancellation_rollback'],
                    null,
                    'SELECT count(*) FROM cancellation_rollback'
                ));
                self::assertSame([[1]], $rootOne->fetch('select', [], null, 'SELECT 1'));
                self::assertSame('C', fread($eventRead, 1), 'the controller issued the duplicate cancellation');
                self::assertSame('1', fread($resultRead, 1), 'the second active root rolled back and reopened');
            } finally {
                fclose($eventRead);
                fclose($resultRead);
                pcntl_waitpid($worker, $workerStatus);
                pcntl_waitpid($controller, $controllerStatus);
                $rootOne->close();
                $rootTwo->close();
            }
            self::assertTrue(pcntl_wifexited($workerStatus), 'the second active-query process exited normally');
            self::assertSame(0, pcntl_wexitstatus($workerStatus), 'the second active-query process verified reuse');
            self::assertTrue(pcntl_wifexited($controllerStatus), 'the cancellation controller exited normally');
            self::assertSame(
                0,
                pcntl_wexitstatus($controllerStatus),
                'the controller observed and cancelled both SQL events',
            );
        });
    }
}
