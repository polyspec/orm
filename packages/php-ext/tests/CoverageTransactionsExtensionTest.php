<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use Polyspec\Orm\Db;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\Config;
use DateTimeZone;
use PDO;
use ReflectionMethod;

#[Medium]
final class CoverageTransactionsExtensionTest extends CoverageTransactionsTest
{
    public function testNativeMethodsAreInternal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Db::class, 'transaction'))->isInternal());
    }

    public function testNativeSqliteTransactionCommitsAndPublishesOneTransactionId(): void
    {
        $events = [];
        [$pdo, $db, $unsubscribe] = self::nativeSqliteTransactionContext($events);

        try {
            $db->run(StatementEvent::SCHEMA, [], null, 'CREATE TABLE lifecycle_rows (value TEXT NOT NULL)');
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
        } finally {
            $unsubscribe();
            $db->close();
        }
    }

    public function testNativeSqliteRollbackStatementDiscardsRowsAndPublishesEvent(): void
    {
        $events = [];
        [$pdo, $db, $unsubscribe] = self::nativeSqliteTransactionContext($events);

        try {
            $db->run(StatementEvent::SCHEMA, [], null, 'CREATE TABLE lifecycle_rows (value TEXT NOT NULL)');
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
            self::assertSame(
                [StatementEvent::SCHEMA, StatementEvent::BEGIN, StatementEvent::INSERT,
                    StatementEvent::ROLLBACK, StatementEvent::SELECT],
                array_map(static fn(StatementEvent $event): string => $event->kind, $events)
            );
            self::assertSame(
                [null, null, null, null, null],
                array_map(static fn(StatementEvent $event): ?int => $event->transaction, $events)
            );
        } finally {
            $unsubscribe();
            $db->close();
        }
    }

    /** @param list<StatementEvent> $events
     * @return array{PDO, Db, \Closure}
     */
    private static function nativeSqliteTransactionContext(array &$events): array
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $unsubscribe = $db->subscribe(static function (StatementEvent $event) use (&$events): void {
            $events[] = $event;
        });
        return [$pdo, $db, $unsubscribe];
    }
}
