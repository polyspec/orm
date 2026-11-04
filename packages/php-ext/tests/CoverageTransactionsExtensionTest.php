<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\StatementEvent;
use PDO;
use ReflectionMethod;

#[Medium]
// The native methods of the transaction surface; the transaction behaviours are the recipe `transactions`.
final class CoverageTransactionsExtensionTest extends TestCase
{
    // Requirements: DSL-124, PLN-19.
    public function testNativeMethodsAreInternal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'transaction'))->isInternal());
        $public = array_map(
            static fn(ReflectionMethod $method): string => strtolower($method->getName()),
            (new \ReflectionClass(Db::class))->getMethods(ReflectionMethod::IS_PUBLIC)
        );
        Assert::assertSame(
            [],
            array_values(array_filter(
                $public,
                static fn(string $name): bool => preg_match('/^(begin|commit|rollback)/', $name) === 1
            )),
            'the extension exposes transaction control only through transaction()'
        );
    }

    public function testNativeSqliteRollbackStatementDiscardsRowsAndPublishesEvent(): void
    {
        self::withLifecycleRows(static function (Db $db, \Closure $recorded): void {
            $db->run(StatementEvent::BEGIN, [], null, 'BEGIN IMMEDIATE', true);
            $db->run(
                StatementEvent::INSERT,
                ['lifecycle_rows'],
                null,
                "INSERT INTO lifecycle_rows (value) VALUES ('rolled_back')",
                true
            );
            $db->run(StatementEvent::ROLLBACK, [], null, 'ROLLBACK', true);

            self::assertSame(
                [],
                $db->fetch(
                    StatementEvent::SELECT,
                    ['lifecycle_rows'],
                    null,
                    'SELECT value FROM lifecycle_rows',
                ),
            );
            $events = $recorded();
            self::assertSame(
                [StatementEvent::SCHEMA, StatementEvent::BEGIN, StatementEvent::INSERT,
                    StatementEvent::ROLLBACK, StatementEvent::SELECT],
                array_map(static fn(StatementEvent $event): string => $event->kind, $events)
            );
            self::assertSame(
                [null, null, null, null, null],
                array_map(static fn(StatementEvent $event): ?int => $event->transaction, $events)
            );
        });
    }

    /**
     * Runs `$body` on a native SQLite Db of a new in-memory database that holds the table lifecycle_rows, with the
     * statement events recorded from its creation on; `$body` reads them with its second argument. The Db is closed
     * and the recording ended on every path.
     *
     * @param \Closure(Db, \Closure(): list<StatementEvent>): void $body
     */
    private static function withLifecycleRows(\Closure $body): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $log = new StatementEventLog($pdo);
        try {
            $log->db->run(StatementEvent::SCHEMA, [], null, 'CREATE TABLE lifecycle_rows (value TEXT NOT NULL)');
            $body($log->db, static fn(): array => $log->events);
        } finally {
            $log->close();
        }
    }
}
