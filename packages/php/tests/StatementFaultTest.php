<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The refusal of an empty argument of the test statement fault of the PHP client (docs/spec/protocol.md 3.2) on
// SQLite, MySQL and PostgreSQL: Polyspec\Orm\Testing\Faults::failNextStatement refuses an empty code or message
// with an InvalidArgumentException, the programmer-error signal of the client, and arms nothing. The refused
// statement, its event and its consumption are the cases a_statement_fault_* of the recipe transactions. The
// cases and the code and message come from contracts/fixtures/statement_fault.json;
// the guard fails when a case of the fixture did not run on every driver.
// Each case runs in a case database of its own (case_database.php) created
// through ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN; the test fails when
// one of the three is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/StatementFaultTest.php
// [--filter <case>]

use RuntimeException;
use Throwable;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Testing\Faults;
use Polyspec\Orm\Tests\StatementFaultCase\StatementProbe;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

#[Large]
class StatementFaultTest extends TestCase
{
    use DatabaseTestAssertions;

    private static mixed $fault = null;

    /** The fixture of the file: what the script did before its cases, once per class. */
    private static function fixture(): void
    {
        // The package autoloader does not load the test entry point, so this test requires it by that path
        // require.
        $faultsAutoloaded = class_exists(\Polyspec\Orm\Testing\Faults::class);
        require_once dirname(__DIR__) . '/testing/Faults.php';

        $fixture = json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/statement_fault.json'),
            true,
            16,
            JSON_THROW_ON_ERROR
        );
        if (
            !is_array($fixture) || (
            $fixture['schema'] ?? null
            ) !== 1 || !is_string($fixture['code'] ?? null) || !is_string(
                $fixture['message'] ?? null
            ) || !is_array($fixture['cases'] ?? null)
        ) {
            throw new RuntimeException('contracts/fixtures/statement_fault.json does not have the schema 1 shape');
        }
        self::$fault = ['code' => $fixture['code'], 'message' => $fixture['message']];

        $schemaText = "dbspec 1 statement_fault\n\ntable statement_probe {\n  seq i64 identity\n  label "
            . "varchar(32)\n  primary key (seq)\n}\n";
        loadGeneratedDocumentSets('orm-php-statement-fault-', [
            'Polyspec\\Orm\\Tests\\StatementFaultCase' => ['statement_fault.dbs' => $schemaText],
        ]);
    }

    /** Opens a Db on the case database and installs the fixture schema. */
    private static function connect(string $dsn): Db
    {
        $db = Orm::connect($dsn, new Config());
        $db->utils()->schema()->install(\Polyspec\Orm\Tests\StatementFaultCase\schema());
        return $db;
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
            self::check(
                $e instanceof \InvalidArgumentException,
                'failNextStatement with code "' . $code . '" and message "' . $message . '" raises ' . (
                    $e === null ? 'nothing' : $e::class . ': ' . $e->getMessage()
                )
            );
        }
        $insert = self::raised(fn() => (new StatementProbe())($db)->setLabel('sent')->create());
        self::check(
            $insert === null,
            'the insert runs because no fault was armed: ' . ($insert === null ? '' : $insert->getMessage())
        );
        self::check((new StatementProbe())($db)->getCount() === 1, 'the insert writes its row');
        $db->close();
    }

    private const CASES = [
        'empty_argument_refused' => 'emptyArgumentRefused',
    ];

    public static function setUpBeforeClass(): void
    {
        self::fixture();
    }

    public function testGeneratedProbeAndSharedThrownResultAreAvailable(): void
    {
        $this->assertTrue(class_exists(StatementProbe::class));
        $this->assertNotSame('', self::$fault['code']);
        $this->assertNotSame('', self::$fault['message']);
        $expected = new RuntimeException('fixture fault');
        $this->assertSame($expected, self::raised(static function () use ($expected): never {
            throw $expected;
        }));
        $ormError = new OrmException(Code::DRIVER, 'fixture database error');
        $this->assertSame($ormError, self::checkedOrmException($ormError, 'fixture statement'));
    }

    /**
     * The cases of contracts/fixtures/statement_fault.json, each a data set named by its id. The guard names every case
     * of the fixture; a fixture case without a body fails here.
     *
     * @return iterable<string, array{string}>
     */
    public static function fixtureCases(): iterable
    {
        $fixture = json_decode(
            (string) file_get_contents(dirname(__DIR__, 3) . '/contracts/fixtures/statement_fault.json'),
            true,
            16,
            JSON_THROW_ON_ERROR
        );
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
    public function testStatementFault(string $case): void
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            with_case_database($driver, static function (string $step): void {
            }, static fn(string $dsn) => [self::class, self::CASES[$case]]($dsn, self::$fault));
        }
    }
}
