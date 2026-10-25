<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Db;
use Polyspec\Orm\StatementEvent;
use PDO;
use ReflectionMethod;

#[Medium]
final class CoverageTransactionsExtensionTest extends CoverageTransactionsTest
{
    // Requirements: PLN-44. The inherited rollback and savepoint cases run with the native Db.
    // Requirements: INT-40, INT-41, INT-42, INT-43, INT-47, INT-48. The inherited exact savepoint selector runs against the native Db.
    // Requirements: PLN-19.
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

    public function testNativeSqliteTransactionCommitsAndPublishesOneTransactionId(): void
    {
        self::withLifecycleRows(static function (Db $db, \Closure $recorded): void {
            $transaction = $db->transaction(function () use ($db): int {
                $transaction = $db->transactionNumber();
                Assert::assertNotNull($transaction);
                $db->run(
                    StatementEvent::INSERT,
                    ['lifecycle_rows'],
                    $transaction,
                    "INSERT INTO lifecycle_rows (value) VALUES ('committed')"
                );
                Assert::assertSame(
                    [['committed']],
                    $db->fetch(
                        StatementEvent::SELECT,
                        ['lifecycle_rows'],
                        $transaction,
                        'SELECT value FROM lifecycle_rows',
                    ),
                );
                return $transaction;
            }, retry: 0);

            self::assertIsInt($transaction);
            self::assertSame(
                ['committed'],
                $db->pdo()->query('SELECT value FROM lifecycle_rows')->fetchAll(PDO::FETCH_COLUMN)
            );
            $events = $recorded();
            self::assertSame(
                [StatementEvent::SCHEMA, StatementEvent::UTILITY, StatementEvent::BEGIN,
                    StatementEvent::INSERT, StatementEvent::SELECT, StatementEvent::COMMIT],
                array_map(static fn(StatementEvent $event): string => $event->kind, $events)
            );
            self::assertSame(
                'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))',
                $events[1]->sql,
            );
            self::assertSame(['orm__row_lock'], $events[1]->tables);
            self::assertNull($events[1]->transaction);
            $transactionEvents = array_values(array_filter(
                $events,
                static fn(StatementEvent $event): bool => $event->transaction !== null
            ));
            self::assertSame(
                [StatementEvent::BEGIN, StatementEvent::INSERT, StatementEvent::SELECT, StatementEvent::COMMIT],
                array_map(static fn(StatementEvent $event): string => $event->kind, $transactionEvents)
            );
            self::assertSame(
                [$transaction, $transaction, $transaction, $transaction],
                array_map(static fn(StatementEvent $event): ?int => $event->transaction, $transactionEvents)
            );
        });
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
