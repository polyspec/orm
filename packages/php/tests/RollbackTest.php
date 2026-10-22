<?php

declare(strict_types=1);

// A transaction or savepoint whose callback fails and whose rollback fails
// too, on SQLite, MySQL and PostgreSQL. The client reports one
// OrmException with the code ROLLBACK that keeps the callback error as its
// previous exception and the rollback error as its rollback. The callback
// runs only model calls. On SQLite a trigger of the test fixture raises
// ROLLBACK when a row labeled `end` is inserted, which ends the transaction,
// so the client's ROLLBACK finds no transaction. On MySQL and PostgreSQL a
// test connection ends the server session that holds the transaction, so the
// next statement and the rollback fail; that connection reaches the server
// through ORM_TEST_MYSQL_SERVER_DSN or ORM_TEST_POSTGRES_SERVER_DSN (the server
// DSNs that make orm-test-servers writes into TEST_ENV), not through a pooler.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when
// one of the four is unset. The case first_statement_lost ends the session of
// a new Db before its first statement, which then fails with CONNECTION_LOST
// and is sent once.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RollbackTest.php
// [--filter <case>]

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Testing\Faults;
use Polyspec\Orm\Tests\RollbackCase\RollbackProbe;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
final class RollbackTest extends TestCase
{
    private static mixed $documents = null;
    private static mixed $faultsAutoloaded = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        // The package autoloader does not load the test entry point, so this test requires it by that path
        // require.
        self::$faultsAutoloaded = class_exists(\Polyspec\Orm\Testing\Faults::class);
        require_once dirname(__DIR__) . '/testing/Faults.php';

        $work = sys_get_temp_dir() . '/orm-php-rollback-' . getmypid();
        @mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });

        self::$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/rollback.dbs')];
        Generator::generate(
            RuntimeModel::build(RuntimeModel::parse(['rollback.dbs' => self::$documents[0]])),
            "$work/models",
            'Polyspec\\Orm\\Tests\\RollbackCase'
        );
        spl_autoload_register(static function (string $class) use ($work): void {
            if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\RollbackCase\\')) {
                require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\RollbackCase\\')) . '.php';
            }
        });
        require "$work/models/bootstrap.php";
    }

    private static function check(bool $ok, string $message): void
    {
        \PHPUnit\Framework\Assert::assertTrue($ok, $message);
    }

    /** The error a call raises, or null when it returns. */
    private static function raised(callable $f): ?Throwable
    {
        try {
            $f();
        } catch (Throwable $e) {
            return $e;
        }
        return null;
    }

    /** A connection of the test, outside the client. */
    private static function native(string $dsn): array
    {
        [$driver, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
        return [$driver, new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION])];
    }

    /** Opens the client, installs the fixture and, on SQLite, the trigger that raises ROLLBACK. */
    private static function connect(string $dsn): Db
    {
        $db = Orm::connect($dsn, new Config());
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\RollbackCase\schema());
        [$driver, $pdo] = self::native($dsn);
        if ($driver === 'sqlite') {
            $pdo->exec(
                "CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN "
                . "SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END"
            );
        }
        return $db;
    }

    /**
     * Ends the server session that holds a lock on rollback_probe in the case
     * database of $dsn. The test connects to that database through
     * ORM_TEST_MYSQL_SERVER_DSN or ORM_TEST_POSTGRES_SERVER_DSN, the server
     * itself, because a pooler in front of it may handle the statement on its
     * own: ProxySQL takes a text-protocol KILL as a command for its own client
     * sessions. The lock on the table of the case database marks the session that
     * holds the transaction behind the pooler. SQLite needs no session end: its
     * trigger ends the transaction.
     */
    private static function endSession(string $dsn): void
    {
        [$driver] = Orm::parseDsn($dsn);
        if ($driver === 'sqlite') {
            return;
        }
        $env = 'ORM_TEST_' . strtoupper($driver) . '_SERVER_DSN';
        $server = requiredDsn($env);
        if ($server === false || $server === '') {
            throw new RuntimeException(
                "$env is required; database tests never skip; run the test through its make target, which reads the "
                . "environment of make orm-test-servers"
            );
        }
        // The case database name is the path of the case DSN. The server connection opens that database too.
        $database = ltrim((string) parse_url($dsn, PHP_URL_PATH), '/');
        [, $pdo] = self::native(case_dsn_with_database($server, $database));
        if ($driver === 'postgres') {
            $pid = $pdo->query(
                "SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = (SELECT oid "
                . "FROM pg_database WHERE datname = current_database()) AND c.relname = 'rollback_probe' AND l.pid "
                . "<> pg_backend_pid() LIMIT 1"
            )->fetchColumn();
            self::check($pid !== false, 'the transaction session holds a lock on rollback_probe');
            $pdo->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([(int) $pid]);
        } else {
            $id = $pdo->query(
                "SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t ON "
                . "t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' "
                . "LIMIT 1"
            )->fetchColumn();
            self::check($id !== false, 'the transaction session holds a lock on rollback_probe');
            $pdo->exec('KILL ' . (int) $id);
        }
    }

    /** Checks a ROLLBACK error: both errors are kept and the message names both. */
    private static function checkRollback(?Throwable $e, string $subject): void
    {
        self::check(
            $e instanceof OrmException,
            "$subject raises " . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage())
        );
        if (!$e instanceof OrmException) {
            return;
        }
        self::check($e->code_ === Code::ROLLBACK, "$subject code {$e->code_}: {$e->getMessage()}");
        self::check($e->getPrevious() !== null, "$subject keeps the callback error");
        self::check($e->rollback !== null, "$subject keeps the rollback error");
        if ($e->getPrevious() !== null && $e->rollback !== null) {
            self::check(
                str_contains(
                    $e->getMessage(),
                    $e->getPrevious()->getMessage()
                ) && str_contains($e->getMessage(), $e->rollback->getMessage()),
                "$subject message names both errors: {$e->getMessage()}"
            );
        }
    }

    /** The callback of a transaction fails and the rollback fails. */
    private static function rollbackFailed(string $dsn): void
    {
        $db = self::connect($dsn);
        $driver = $db->driver();
        $e = self::raised(fn() => $db->transaction(function () use ($db, $dsn): void {
            (new RollbackProbe())($db)->setLabel('kept')->create();
            self::endSession($dsn);
            (new RollbackProbe())($db)->setLabel('end')->create();
        }, retry: 0));
        self::checkRollback($e, 'transaction');
        if ($driver !== 'sqlite' && $e instanceof OrmException) {
            // A next statement and a rollback on a session the server ended fail with a lost-connection error.
            $callback = $e->getPrevious();
            self::check(
                $callback instanceof OrmException && $callback->code_ === Code::CONNECTION_LOST,
                'the callback error is CONNECTION_LOST: ' . ($callback === null ? 'none' : $callback->getMessage())
            );
            self::check(
                $e->rollback instanceof OrmException && $e->rollback->code_ === Code::CONNECTION_LOST,
                'the rollback error is CONNECTION_LOST: ' . (
                    $e->rollback === null ? 'none' : $e->rollback->getMessage()
                )
            );
        }
        if ($driver === 'sqlite' && $e instanceof OrmException && $e->getPrevious() !== null) {
            self::check(
                str_contains($e->getPrevious()->getMessage(), 'rollback probe ended the transaction'),
                'callback error ' . $e->getPrevious()->getMessage()
            );
            self::check(
                (new RollbackProbe())($db)->getCount() === 0,
                'the trigger rolled the transaction back and the connection serves later requests'
            );
        }
        $db->close();
    }

    /** The callback of a savepoint fails and the savepoint rollback fails, and then the transaction rollback fails. */
    private static function savepointRollbackFailed(string $dsn): void
    {
        $db = self::connect($dsn);
        $driver = $db->driver();
        $e = self::raised(fn() => $db->transaction(function () use ($db, $dsn): void {
            (new RollbackProbe())($db)->setLabel('kept')->create();
            $db->transaction(function () use ($db, $dsn): void {
                (new RollbackProbe())($db)->setLabel('nested')->create();
                self::endSession($dsn);
                (new RollbackProbe())($db)->setLabel('end')->create();
            });
        }, retry: 0));
        self::checkRollback($e, 'transaction');
        $inner = $e instanceof OrmException ? $e->getPrevious() : null;
        self::checkRollback($inner, 'savepoint');
        if ($driver === 'sqlite') {
            self::check(
                (new RollbackProbe())($db)->getCount() === 0,
                'the trigger rolled the transaction back and the connection serves later requests'
            );
        }
        $db->close();
    }

    /**
     * The rollback fault of the test entry point. A committed transaction leaves a fault behind,
     * a transaction after a failed callback is rolled back, and that rollback reports FAULT
     * and the transaction throws the callback error and a ROLLBACK with the fault. The fault
     * is consumed: the transaction after it throws only the callback error, and the connection
     * handles later requests.
     */
    private static function rollbackFault(string $dsn): void
    {
        // Requirements: PRT-46, PRT-56, PRT-61.
        self::check(self::$faultsAutoloaded === false, 'the package autoloader loads Polyspec\\Orm\\Testing\\Faults');
        foreach (['fixClock', 'lastAffected'] as $entry) {
            self::check(method_exists(Faults::class, $entry), "Polyspec\\Orm\\Testing\\Faults has no {$entry}");
        }
        $db = self::connect($dsn);
        Faults::failNextRollback($db);
        $committed = self::raised(fn() => $db->transaction(function () use ($db): void {
            (new RollbackProbe())($db)->setLabel('committed')->create();
        }, retry: 0));
        self::check(
            $committed === null,
            'a committed transaction with an armed fault raises ' . (
                $committed === null ? '' : $committed->getMessage()
            )
        );
        $callback = new RuntimeException('rollback fault callback failed');
        $failing = function () use ($db, $callback): void {
            (new RollbackProbe())($db)->setLabel('rolled back')->create();
            throw $callback;
        };
        $e = self::raised(fn() => $db->transaction($failing, retry: 0));
        self::checkRollback($e, 'transaction');
        if ($e instanceof OrmException) {
            self::check($e->getPrevious() === $callback, 'the ROLLBACK error keeps the callback error itself');
            self::check(
                $e->rollback instanceof OrmException && $e->rollback->code_ === Code::FAULT,
                'the rollback error is FAULT: ' . ($e->rollback === null ? 'none' : $e->rollback->getMessage())
            );
        }
        self::check((new RollbackProbe())($db)->getCount() === 1, 'the faulted rollback keeps only the committed row');
        $again = self::raised(fn() => $db->transaction($failing, retry: 0));
        self::check(
            $again === $callback,
            'the transaction after the consumed fault raises the callback error: ' . (
                $again === null ? 'nothing' : $again->getMessage()
            )
        );
        self::check((new RollbackProbe())($db)->getCount() === 1, 'the second rollback keeps only the committed row');
        $db->close();
    }

    /**
     * The server ends the session of a new Db before its first statement. The
     * statement fails with CONNECTION_LOST and is sent once: the client opens no
     * other connection and does not send it again. The Db connects through the
     * server DSN, as endSession does, so the ended session is the session of the
     * Db and not a session behind a pooler. A pooler in front of the case
     * database (client-pooler-check) keeps its own server sessions there after
     * the fixture is installed through it, and another session of the case
     * database may open while the Db connects, so the session of the Db is found
     * by the id that its own connection reports.
     */
    private static function firstStatementLost(string $dsn): void
    {
        [$driver] = Orm::parseDsn($dsn);
        self::connect($dsn)->close();
        $env = 'ORM_TEST_' . strtoupper($driver) . '_SERVER_DSN';
        $server = requiredDsn($env);
        if ($server === false || $server === '') {
            throw new RuntimeException(
                "$env is required; database tests never skip; run the test through its make target, which reads the "
                . "environment of make orm-test-servers"
            );
        }
        $direct = case_dsn_with_database($server, ltrim((string) parse_url($dsn, PHP_URL_PATH), '/'));
        [, $pdo] = self::native($direct);
        // Another client's session in the case database, such as a server connection of a pooler, is open
        // while the Db connects. It is not the session of the Db, so the Db finds its own session by its id.
        [, $other] = self::native($direct);
        $db = Orm::connect($direct, new Config());
        $db->utils()->schema()->register(\Polyspec\Orm\Tests\RollbackCase\schema());
        $events = [];
        $db->subscribe(function ($event) use (&$events): void {
            $events[] = $event->error?->code_;
        });
        // The id of the server session of the Db (pg_backend_pid, CONNECTION_ID) is the property only that session has.
        $id = (int) $db->pdo()
            ->query($driver === 'postgres' ? 'SELECT pg_backend_pid()' : 'SELECT CONNECTION_ID()')
            ->fetchColumn();
        self::check($id > 0, "the Db reports the id of its session: $id");
        self::check(
            $id !== (int) $other->query(
                $driver === 'postgres' ? 'SELECT pg_backend_pid()' : 'SELECT CONNECTION_ID()'
            )->fetchColumn(),
            'the id of the Db is not the id of the other session'
        );
        if ($driver === 'postgres') {
            $pdo->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([$id]);
        } else {
            $pdo->exec('KILL ' . $id);
        }
        $e = self::raised(fn() => (new RollbackProbe())($db)->getCount());
        self::check(
            $e instanceof OrmException && $e->code_ === Code::CONNECTION_LOST,
            'the first statement fails with CONNECTION_LOST: ' . ($e === null ? 'no error' : $e->getMessage())
        );
        self::check($events === [Code::CONNECTION_LOST], 'the statement is sent once: ' . json_encode($events));
    }

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    /** @return iterable<string, array{string}> the drivers of the case, each a data set */
    public static function drivers(): iterable
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }

    #[DataProvider('drivers')]
    public function testRollbackFailed(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::rollbackFailed($dsn));
    }

    #[DataProvider('drivers')]
    public function testSavepointRollbackFailed(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::savepointRollbackFailed($dsn));
    }

    #[DataProvider('drivers')]
    public function testRollbackFault(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::rollbackFault($dsn));
    }

    #[DataProvider('serverDrivers')]
    // Requirements: CFG-15.
    public function testFirstStatementLost(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::firstStatementLost($dsn));
    }

    /** SQLite has no server session to end, so first_statement_lost runs on MySQL and PostgreSQL. */
    public static function serverDrivers(): iterable
    {
        foreach (['mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }
}
