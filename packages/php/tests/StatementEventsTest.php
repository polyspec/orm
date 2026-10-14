<?php
// Statement events on SQLite, MySQL and PostgreSQL: every case of the shared
// vector tests/events/vectors.json in a case database of its own
// (statement_events_run.php), one test method per database with the vector's
// case ids as its data sets, and the vector's server_transactions on
// PostgreSQL. The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN
// is unset.
// Usage: packages/php/vendor/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/StatementEventsTest.php [--filter <method or data set>]
declare(strict_types=1);

require_once __DIR__ . '/statement_events_run.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// A case creates its case database, installs the fixture, runs about ten statements and drops the database.
#[Medium]
final class StatementEventsTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        statementEventsModels();
    }

    /** @return iterable<string, array{array<string, mixed>}> the cases of tests/events/vectors.json by id */
    public static function cases(): iterable
    {
        foreach (statementEventsVector()['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    private static function runOn(string $driver, array $case): void
    {
        with_case_database($driver, static function (string $text): void {}, static fn(string $dsn) => runCase($case, $driver, $dsn));
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function test_sqlite(array $case): void
    {
        self::runOn('sqlite', $case);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function test_mysql(array $case): void
    {
        self::runOn('mysql', $case);
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function test_postgres(array $case): void
    {
        self::runOn('postgres', $case);
    }

    public function test_server_transactions(): void
    {
        $vector = statementEventsVector();
        $cases = array_column($vector['cases'], null, 'id');
        $spec = $vector['server_transactions'];
        with_case_database($spec['database'], static function (string $text): void {}, static fn(string $dsn) => runServerTransactions($spec, $cases, $dsn));
    }
}
