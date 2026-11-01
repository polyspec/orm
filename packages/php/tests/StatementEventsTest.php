<?php

// Statement events on SQLite, MySQL and PostgreSQL that the recipe
// contracts/fixtures/statement_events/statement_events.json does not cover: the
// unsubscribe memory check, and each entry of the vector's server_transactions on
// its database (statement_events_run.php). The eight cases of tests/events/vectors.json
// run as the recipe (statement_events-<database>). The test fails when
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/StatementEventsTest.php [--filter <method>]
declare(strict_types=1);

// Requirements: INT-77, INT-96, PLN-44.

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// A case creates its case database, installs the fixture, runs about ten statements and drops the database.
#[Medium]
class StatementEventsTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        statementEventsModels();
    }

    /**
     * Unsubscribing frees the function of the unsubscribe closure: a process that subscribes and unsubscribes
     * over and over keeps its memory flat. The extension's allocation is persistent, so the measure is the
     * resident set of this process (ps), not memory_get_usage.
     */
    public function testUnsubscribeFreesClosure(): void
    {
        $path = sys_get_temp_dir() . '/unsubscribe-leak-' . getmypid() . '.sqlite';
        if (file_exists($path)) {
            unlink($path);
        }
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
            self::assertLessThan(
                10240,
                $grew,
                "resident set grew by {$grew} KB over 200000 subscribe/unsubscribe cycles",
            );
        } finally {
            if (file_exists($path)) {
                unlink($path);
            }
        }
    }

    /** The key of this client in the lists of server_transactions. */
    protected static function serverTransactionsClient(): string
    {
        return 'php';
    }

    // Requirements: INT-149.
    public function testServerTransactions(): void
    {
        $vector = statementEventsVector();
        $cases = array_column($vector['cases'], null, 'id');
        $client = static::serverTransactionsClient();
        foreach ($vector['server_transactions'] as $spec) {
            with_case_database($spec['database'], static function (string $text): void {
            }, static fn(string $dsn) => runServerTransactions($spec, $cases, $dsn, $client));
        }
    }

    // Requirements: INT-149. Every database of the statement events is named once: by an entry, or by an excluded
    // database with its reason. SQLite is excluded (CR16-2).
    public function testServerTransactionsNamedOnce(): void
    {
        $vector = statementEventsVector();
        $named = array_column($vector['server_transactions'], 'database');
        $excluded = $vector['server_transactions_excluded'] ?? [];
        $this->assertSame(array_values(array_unique($named)), $named, 'an entry names a database twice');
        $this->assertSame(
            [],
            array_values(array_intersect($named, array_keys($excluded))),
            'a database is both an entry and excluded'
        );
        $all = array_values(array_unique([...$named, ...array_keys($excluded)]));
        sort($all);
        $this->assertSame(['mysql', 'postgres', 'sqlite'], $all);
        foreach ($excluded as $database => $exclusion) {
            $this->assertNotSame(
                '',
                trim((string) ($exclusion['reason'] ?? '')),
                "the exclusion of $database states no reason"
            );
        }
    }
}
