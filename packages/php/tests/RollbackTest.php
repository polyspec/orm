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
// DSNs that make test-servers writes into TEST_ENV), not through a pooler.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when
// one of the four is unset. The case first_statement_lost ends the session of
// a new Db before its first statement, which then fails with CONNECTION_LOST
// and is sent once.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RollbackTest.php [--filter <case>]
require_once __DIR__ . '/case_database.php';

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
        // package autoloader는 test entry point를 load하지 않으므로 이 test는 그 path로
        // require한다.
        self::$faultsAutoloaded = class_exists(\Polyspec\Orm\Testing\Faults::class);
        require_once dirname(__DIR__) . '/testing/Faults.php';

        $work = sys_get_temp_dir() . '/orm-php-rollback-' . getmypid();
        @mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });

        self::$documents = [(string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/rollback.dbs')];
        Generator::generate(RuntimeModel::build(RuntimeModel::parse(['rollback.dbs' => self::$documents[0]])), "$work/models", 'Polyspec\\Orm\\Tests\\RollbackCase');
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
            $pdo->exec("CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END");
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
        $server = getenv($env);
        if ($server === false || $server === '') {
            throw new RuntimeException("$env is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers");
        }
        // case database 이름은 case DSN의 path다. server 연결도 그 database를 연다.
        $database = ltrim((string) parse_url($dsn, PHP_URL_PATH), '/');
        [, $pdo] = self::native(case_dsn_with_database($server, $database));
        if ($driver === 'postgres') {
            $pid = $pdo->query("SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1")->fetchColumn();
            self::check($pid !== false, 'the transaction session holds a lock on rollback_probe');
            $pdo->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([(int) $pid]);
        } else {
            $id = $pdo->query("SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' LIMIT 1")->fetchColumn();
            self::check($id !== false, 'the transaction session holds a lock on rollback_probe');
            $pdo->exec('KILL ' . (int) $id);
        }
    }

    /** Checks a ROLLBACK error: both errors are kept and the message names both. */
    private static function checkRollback(?Throwable $e, string $subject): void
    {
        self::check($e instanceof OrmException, "$subject raises " . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
        if (!$e instanceof OrmException) {
            return;
        }
        self::check($e->code_ === Code::ROLLBACK, "$subject code {$e->code_}: {$e->getMessage()}");
        self::check($e->getPrevious() !== null, "$subject keeps the callback error");
        self::check($e->rollback !== null, "$subject keeps the rollback error");
        if ($e->getPrevious() !== null && $e->rollback !== null) {
            self::check(str_contains($e->getMessage(), $e->getPrevious()->getMessage()) && str_contains($e->getMessage(), $e->rollback->getMessage()), "$subject message names both errors: {$e->getMessage()}");
        }
    }

    /** The callback of a transaction fails and the rollback fails. */
    private static function rollbackFailed(string $dsn): void
    {
        $db = self::connect($dsn);
        $driver = $db->driver();
        $e = self::raised(fn() => $db->transaction(function () use ($db, $dsn): void {
            (new RollbackProbe)($db)->setLabel('kept')->create();
            self::endSession($dsn);
            (new RollbackProbe)($db)->setLabel('end')->create();
        }, retry: 0));
        self::checkRollback($e, 'transaction');
        if ($driver !== 'sqlite' && $e instanceof OrmException) {
            // server가 끝낸 session의 다음 statement와 rollback은 연결을 잃은 오류다.
            $callback = $e->getPrevious();
            self::check($callback instanceof OrmException && $callback->code_ === Code::CONNECTION_LOST, 'the callback error is CONNECTION_LOST: ' . ($callback === null ? 'none' : $callback->getMessage()));
            self::check($e->rollback instanceof OrmException && $e->rollback->code_ === Code::CONNECTION_LOST, 'the rollback error is CONNECTION_LOST: ' . ($e->rollback === null ? 'none' : $e->rollback->getMessage()));
        }
        if ($driver === 'sqlite' && $e instanceof OrmException && $e->getPrevious() !== null) {
            self::check(str_contains($e->getPrevious()->getMessage(), 'rollback probe ended the transaction'), 'callback error ' . $e->getPrevious()->getMessage());
            self::check((new RollbackProbe)($db)->getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
        }
        $db->close();
    }

    /** The callback of a savepoint fails and the savepoint rollback fails, and then the transaction rollback fails. */
    private static function savepointRollbackFailed(string $dsn): void
    {
        $db = self::connect($dsn);
        $driver = $db->driver();
        $e = self::raised(fn() => $db->transaction(function () use ($db, $dsn): void {
            (new RollbackProbe)($db)->setLabel('kept')->create();
            $db->transaction(function () use ($db, $dsn): void {
                (new RollbackProbe)($db)->setLabel('nested')->create();
                self::endSession($dsn);
                (new RollbackProbe)($db)->setLabel('end')->create();
            });
        }, retry: 0));
        self::checkRollback($e, 'transaction');
        $inner = $e instanceof OrmException ? $e->getPrevious(): null;
        self::checkRollback($inner, 'savepoint');
        if ($driver === 'sqlite') {
            self::check((new RollbackProbe)($db)->getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
        }
        $db->close();
    }

    /**
     * test entry point의 rollback fault다. commit된 transaction은 fault를 남기고,
     * callback이 실패한 다음 transaction은 rollback되며 그 rollback은 FAULT를 보고하고
     * transaction은 callback 오류와 fault를 가진 ROLLBACK을 throw한다. fault는
     * 소비된다: 그 뒤 transaction은 callback 오류만 throw하고 connection은 이후 요청을
     * 처리한다.
     */
    private static function rollbackFault(string $dsn): void
    {
        self::check(self::$faultsAutoloaded === false, 'the package autoloader loads Polyspec\\Orm\\Testing\\Faults');
        $db = self::connect($dsn);
        Faults::failNextRollback($db);
        $committed = self::raised(fn() => $db->transaction(function () use ($db): void {
            (new RollbackProbe)($db)->setLabel('committed')->create();
        }, retry: 0));
        self::check($committed === null, 'a committed transaction with an armed fault raises ' . ($committed === null ? '' : $committed->getMessage()));
        $callback = new RuntimeException('rollback fault callback failed');
        $failing = function () use ($db, $callback): void {
            (new RollbackProbe)($db)->setLabel('rolled back')->create();
            throw $callback;
        };
        $e = self::raised(fn() => $db->transaction($failing, retry: 0));
        self::checkRollback($e, 'transaction');
        if ($e instanceof OrmException) {
            self::check($e->getPrevious() === $callback, 'the ROLLBACK error keeps the callback error itself');
            self::check($e->rollback instanceof OrmException && $e->rollback->code_ === Code::FAULT, 'the rollback error is FAULT: ' . ($e->rollback === null ? 'none' : $e->rollback->getMessage()));
        }
        self::check((new RollbackProbe)($db)->getCount() === 1, 'the faulted rollback keeps only the committed row');
        $again = self::raised(fn() => $db->transaction($failing, retry: 0));
        self::check($again === $callback, 'the transaction after the consumed fault raises the callback error: ' . ($again === null ? 'nothing' : $again->getMessage()));
        self::check((new RollbackProbe)($db)->getCount() === 1, 'the second rollback keeps only the committed row');
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
        $server = getenv($env);
        if ($server === false || $server === '') {
            throw new RuntimeException("$env is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers");
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
        $id = (int) $db->pdo()->query($driver === 'postgres' ? 'SELECT pg_backend_pid()' : 'SELECT CONNECTION_ID()')->fetchColumn();
        self::check($id > 0, "the Db reports the id of its session: $id");
        self::check($id !== (int) $other->query($driver === 'postgres' ? 'SELECT pg_backend_pid()' : 'SELECT CONNECTION_ID()')->fetchColumn(), 'the id of the Db is not the id of the other session');
        if ($driver === 'postgres') {
            $pdo->prepare('SELECT pg_terminate_backend(?, 5000)')->execute([$id]);
        } else {
            $pdo->exec('KILL ' . $id);
        }
        $e = self::raised(fn() => (new RollbackProbe)($db)->getCount());
        self::check($e instanceof OrmException && $e->code_ === Code::CONNECTION_LOST, 'the first statement fails with CONNECTION_LOST: ' . ($e === null ? 'no error' : $e->getMessage()));
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
    public function test_rollback_failed(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::rollbackFailed($dsn));
    }

    #[DataProvider('drivers')]
    public function test_savepoint_rollback_failed(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::savepointRollbackFailed($dsn));
    }

    #[DataProvider('drivers')]
    public function test_rollback_fault(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::rollbackFault($dsn));
    }

    #[DataProvider('serverDrivers')]
    public function test_first_statement_lost(string $driver): void
    {
        // The case installs its documents in a case database of its own, removed when it ends, also when it fails.
        with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => self::firstStatementLost($dsn));
    }

    /** SQLite has no server session to end, so first_statement_lost runs on MySQL and PostgreSQL. */
    public static function serverDrivers(): iterable
    {
        foreach (['mysql', 'postgres'] as $driver) {
            yield $driver => [$driver];
        }
    }
}
