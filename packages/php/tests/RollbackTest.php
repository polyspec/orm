<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The rollback fault of the test entry point, and a server that ends the session of a new Db before its first statement,
// which then fails with CONNECTION_LOST and is sent once (CFG-38). The failed rollbacks of CFG-15 and INT-155 are cases of
// contracts/fixtures/transactions/transactions.json. Each case runs in a case database of its own (case_database.php).
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RollbackTest.php
// [--filter <case>]

use PDO;
use RuntimeException;
use Throwable;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Testing\Faults;
use Polyspec\Orm\Tests\RollbackCase\RollbackProbe;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Medium]
class RollbackTest extends TestCase
{
    use ThreeDrivers;
    use DatabaseTestAssertions;

    private static mixed $faultsAutoloaded = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        // The package autoloader does not load the test entry point, so this test requires it by that path
        // require.
        self::$faultsAutoloaded = class_exists(\Polyspec\Orm\Testing\Faults::class);
        require_once dirname(__DIR__) . '/testing/Faults.php';

        loadGeneratedFixture(
            'orm-php-rollback-',
            'rollback.dbs',
            'Polyspec\\Orm\\Tests\\RollbackCase'
        );
    }

    /** A connection of the test, outside the client. */
    private static function native(string $dsn): array
    {
        return self::nativeConnection($dsn);
    }

    /** Opens the client and installs the fixture. */
    private static function connect(string $dsn): Db
    {
        $db = Orm::connect($dsn, new Config());
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\RollbackCase\schema());
        return $db;
    }

    private static function serverDsn(string $driver): string
    {
        $env = 'ORM_TEST_' . strtoupper($driver) . '_SERVER_DSN';
        $server = requiredDsn($env);
        if ($server === false || $server === '') {
            throw new RuntimeException(
                "$env is required; database tests never skip; run the test through its make target, which reads the "
                . "environment of make orm-test-servers"
            );
        }
        return $server;
    }

    /** Checks a ROLLBACK error: both errors are kept and the message names both. */
    private static function checkRollback(?Throwable $e, string $subject): void
    {
        $e = self::checkedOrmException($e, $subject);
        if ($e === null) {
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
        $server = self::serverDsn($driver);
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

    #[DataProvider('drivers')]
    // Requirements: INT-72.
    public function testRollbackFault(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::rollbackFault($dsn));
    }

    #[DataProvider('serverDrivers')]
    // Requirements: CFG-38.
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
