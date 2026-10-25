<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use DateTimeZone;
use PDO;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\TransactionFailureCases;
use ReflectionClass;

// Requirements: INT-67, INT-72, DIA-181, PLN-17.
final class TransactionFailureNativeTest extends TestCase
{
    use TransactionFailureCases;

    protected function setUp(): void
    {
        self::assertTrue((new ReflectionClass(Db::class))->isInternal());
    }

    public function testSqliteRowLockEventBelongsToEachTransaction(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $events = [];
        $db->subscribe(static function (\Polyspec\Orm\StatementEvent $event) use (&$events): void {
            $events[] = [$event->kind, $event->sql, $event->transaction];
        });

        for ($transaction = 1; $transaction <= 2; $transaction++) {
            $db->transaction(static function () use ($db): void {
                $db->acquireSQLiteRowLock('update');
            });
            $expected = [
                ['begin', 'BEGIN IMMEDIATE', $transaction],
                [
                    'utility',
                    'INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id"=excluded."id"',
                    $transaction,
                ],
                ['commit', 'COMMIT', $transaction],
            ];
            self::assertSame(
                $expected,
                array_slice($events, -3),
                'the row-lock write is ordered inside its transaction',
            );
            self::assertSame(1, (int) $pdo->query('SELECT COUNT(*) FROM "orm__row_lock"')->fetchColumn());
        }

        $db->close();
    }
}
