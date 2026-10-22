<?php

// Statement events on SQLite, MySQL and PostgreSQL: every case of the shared
// vector tests/events/vectors.json in a case database of its own
// (statement_events_run.php), one data set per case id that runs the case on each
// database in turn, and the vector's server_transactions on
// PostgreSQL. The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN
// is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/StatementEventsTest.php [--filter <method or data set>]
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

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
        with_case_database($driver, static function (string $text): void {
        }, static fn(string $dsn) => runCase($case, $driver, $dsn));
    }

    /**
     * The case on SQLite, MySQL and PostgreSQL in turn, each in a case database of its own.
     *
     * @param array<string, mixed> $case
     */
    #[DataProvider('cases')]
    public function testCase(array $case): void
    {
        foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
            self::runOn($driver, $case);
        }
    }

    /**
     * Unsubscribing frees the function of the unsubscribe closure: a process that subscribes and unsubscribes
     * over and over keeps its memory flat. The extension's allocation is persistent, so the measure is the
     * resident set of this process (ps), not memory_get_usage.
     */
    public function testUnsubscribeFreesClosure(): void
    {
        $path = sys_get_temp_dir() . '/unsubscribe-leak-' . getmypid() . '.sqlite';
        @unlink($path);
        try {
            $db = \Polyspec\Orm\Orm::connect('sqlite://' . $path, new \Polyspec\Orm\Config());
            $rss = static fn(): int => (int) trim((string) shell_exec('ps -o rss= -p ' . getmypid()));
            $cycle = static function (\Polyspec\Orm\Db $db): void {
                $stop = $db->subscribe(static function (): void {
                });
                $stop();
            };
            for ($i = 0; $i < 20000; $i++) {
                $cycle($db);
            }
            $before = $rss();
            for ($i = 0; $i < 200000; $i++) {
                $cycle($db);
            }
            $grew = $rss() - $before;
            self::assertLessThan(10240, $grew, "resident set grew by {$grew} KB over 200000 subscribe/unsubscribe cycles");
        } finally {
            @unlink($path);
        }
    }

    public function testServerTransactions(): void
    {
        $vector = statementEventsVector();
        $cases = array_column($vector['cases'], null, 'id');
        $spec = $vector['server_transactions'];
        with_case_database($spec['database'], static function (string $text): void {
        }, static fn(string $dsn) => runServerTransactions($spec, $cases, $dsn));
    }
}
