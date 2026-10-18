<?php
declare(strict_types=1);
// The test statement fault of the PHP client (docs/protocol.md 3.2) on SQLite,
// MySQL and PostgreSQL. A test arms the fault through
// Polyspec\Orm\Testing\Faults::failNextStatement; the next statement of the
// connection is not sent and the client reports it as an OrmException with
// the armed code and message, at the statement end of a driver error. The
// cases and the code and message come from contracts/fixtures/statement_fault.json;
// the guard fails when a case of the fixture did not run on every driver.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when
// one of the three is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/StatementFaultTest.php [--filter <case>]
require_once __DIR__ . '/case_database.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Generator;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Testing\Faults;
use Polyspec\Orm\Tests\StatementFaultCase\StatementProbe;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Large]
final class StatementFaultTest extends TestCase
{
    private static mixed $fault = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        // The package autoloader does not load the test entry point, so this test requires it by that path
        // require.
        $faultsAutoloaded = class_exists(\Polyspec\Orm\Testing\Faults::class);
        require_once dirname(__DIR__) . '/testing/Faults.php';

        $fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/statement_fault.json'), true, 16, JSON_THROW_ON_ERROR);
        if (!is_array($fixture) || ($fixture['schema'] ?? null) !== 1 || !is_string($fixture['code'] ?? null) || !is_string($fixture['message'] ?? null) || !is_array($fixture['cases'] ?? null)) {
            throw new RuntimeException('contracts/fixtures/statement_fault.json does not have the schema 1 shape');
        }
        self::$fault = ['code' => $fixture['code'], 'message' => $fixture['message']];

        $work = sys_get_temp_dir() . '/orm-php-statement-fault-' . getmypid();
        @mkdir($work, 0o700, true);
        register_shutdown_function(static function () use ($work): void {
            exec('rm -rf ' . escapeshellarg($work));
        });

        $schemaText = "dbspec 1 statement_fault\n\ntable statement_probe {\n  seq i64 identity\n  label varchar(32)\n  primary key (seq)\n}\n";
        Generator::generate(RuntimeModel::build(RuntimeModel::parse(['statement_fault.dbs' => $schemaText])), "$work/models", 'Polyspec\\Orm\\Tests\\StatementFaultCase');
        spl_autoload_register(static function (string $class) use ($work): void {
            if (str_starts_with($class, 'Polyspec\\Orm\\Tests\\StatementFaultCase\\')) {
                require "$work/models/" . substr($class, strlen('Polyspec\\Orm\\Tests\\StatementFaultCase\\')) . '.php';
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

    /** Opens a Db on the case database and installs the fixture schema. */
    private static function connect(string $dsn): Db
    {
        $db = Orm::connect($dsn, new Config());
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\StatementFaultCase\schema());
        return $db;
    }

    /** Checks an OrmException with the armed code, whose message names the armed message. */
    private static function checkFault(?Throwable $e, string $subject, array $fault): void
    {
        self::check($e instanceof OrmException, "$subject raises " . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
        if (!$e instanceof OrmException) {
            return;
        }
        self::check($e->code_ === $fault['code'], "$subject code {$e->code_}: {$e->getMessage()}");
        self::check(str_contains($e->getMessage(), $fault['message']), "$subject message names the armed message: {$e->getMessage()}");
    }

    /**
     * The armed statement is refused: the insert is not sent, the database keeps
     * no row, and the statement event of the insert carries the armed error.
     */
    private static function refusedInsert(string $dsn, array $fault): void
    {
        $db = self::connect($dsn);
        $events = [];
        $db->subscribe(function ($event) use (&$events): void {
            $events[] = [$event->kind, $event->error?->code_];
        });
        Faults::failNextStatement($db, $fault['code'], $fault['message']);
        $e = self::raised(fn() => (new StatementProbe)($db)->setLabel('refused')->create());
        self::checkFault($e, 'insert', $fault);
        self::check((new StatementProbe)($db)->getCount() === 0, 'the refused insert leaves no row');
        self::check(in_array(['insert', $fault['code']], $events, true), 'the statement event of the insert carries ' . $fault['code'] . ': ' . json_encode($events));
        $db->close();
    }

    /** The fault is consumed by the one statement it refuses: the next insert is sent and writes its row. */
    private static function consumedByOneStatement(string $dsn, array $fault): void
    {
        $db = self::connect($dsn);
        Faults::failNextStatement($db, $fault['code'], $fault['message']);
        $e = self::raised(fn() => (new StatementProbe)($db)->setLabel('refused')->create());
        self::checkFault($e, 'first insert', $fault);
        $second = self::raised(fn() => (new StatementProbe)($db)->setLabel('sent')->create());
        self::check($second === null, 'the second insert runs after the consumed fault: ' . ($second === null ? '' : $second->getMessage()));
        self::check((new StatementProbe)($db)->getCount() === 1, 'only the second insert writes a row');
        $db->close();
    }

    /**
     * The first statement in a transaction is the armed insert, so the fault
     * survives the transaction's BEGIN. The transaction ends by its callback error,
     * which is the armed error and not a ROLLBACK error, and the row is not written.
     */
    private static function refusedInTransaction(string $dsn, array $fault): void
    {
        $db = self::connect($dsn);
        Faults::failNextStatement($db, $fault['code'], $fault['message']);
        $e = self::raised(fn() => $db->transaction(function () use ($db): void {
            (new StatementProbe)($db)->setLabel('in transaction')->create();
        }, retry: 0));
        self::checkFault($e, 'transaction', $fault);
        self::check((new StatementProbe)($db)->getCount() === 0, 'the transaction with the refused insert writes no row');
        $db->close();
    }

    /**
     * An empty code or an empty message is refused with the usage error of the
     * client (\InvalidArgumentException in the PHP client) and arms nothing: the
     * next insert runs and writes its row.
     */
    private static function emptyArgumentRefused(string $dsn, array $fault): void
    {
        $db = self::connect($dsn);
        $empty = [['', $fault['message']], [$fault['code'], '']];
        foreach ($empty as [$code, $message]) {
            $e = self::raised(fn() => Faults::failNextStatement($db, $code, $message));
            self::check($e instanceof \InvalidArgumentException, 'failNextStatement with code "' . $code . '" and message "' . $message . '" raises ' . ($e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()));
        }
        $insert = self::raised(fn() => (new StatementProbe)($db)->setLabel('sent')->create());
        self::check($insert === null, 'the insert runs because no fault was armed: ' . ($insert === null ? '' : $insert->getMessage()));
        self::check((new StatementProbe)($db)->getCount() === 1, 'the insert writes its row');
        $db->close();
    }

    private const CASES = [
        'refused_insert' => 'refusedInsert',
        'consumed_by_one_statement' => 'consumedByOneStatement',
        'refused_in_transaction' => 'refusedInTransaction',
        'empty_argument_refused' => 'emptyArgumentRefused',
    ];

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    /**
     * The cases of contracts/fixtures/statement_fault.json, each a data set named by its id. The guard names every case of
     * the fixture; a fixture case without a body fails here.
     *
     * @return iterable<string, array{string}>
     */
    public static function fixtureCases(): iterable
    {
        $fixture = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/statement_fault.json'), true, 16, JSON_THROW_ON_ERROR);
        foreach ($fixture['cases'] as $name) {
            if (!isset(self::CASES[$name])) {
                throw new RuntimeException("fixture case $name has no body in StatementFaultTest.php");
            }
            yield $name => [$name];
        }
    }

    /**
     * The case passes when it passes on SQLite, MySQL and PostgreSQL; each run has a case database of its own and the
     * database is removed when the run ends, also when it fails.
     */
    #[DataProvider('fixtureCases')]
    public function test_statement_fault(string $case): void
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            with_case_database($driver, static function (string $step): void {}, static fn(string $dsn) => [self::class, self::CASES[$case]]($dsn, self::$fault));
        }
    }
}
