<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use DateTimeZone;
use PDO;
use Polyspec\Orm\Config;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
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

    // Requirements: INT-47.
    public function testAnotherFiberCannotUseAnActiveNativeTransactionConnection(): void
    {
        $db = new Db(new PDO('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
        $beforeSuspend = null;
        $afterResume = null;
        $nestedCalls = 0;
        $fiber = new \Fiber(static function () use ($db, &$beforeSuspend, &$afterResume, &$nestedCalls): void {
            $db->transaction(static function () use ($db, &$beforeSuspend, &$afterResume, &$nestedCalls): void {
                $db->transaction(static function () use (&$nestedCalls): void {
                    $nestedCalls++;
                }, retry: 0);
                $beforeSuspend = [$db->transactionNumber(), $nestedCalls];
                \Fiber::suspend();
                $db->transaction(static function () use (&$nestedCalls): void {
                    $nestedCalls++;
                }, retry: 0);
                $afterResume = [$db->transactionNumber(), $nestedCalls];
            }, retry: 0);
        });
        try {
            $error = \Polyspec\Orm\Tests\FiberTransaction::outsideError($fiber, $db);
        } finally {
            $db->close();
        }
        self::assertSame(
            [1, 1],
            $beforeSuspend,
            'the owning fiber can read and nest its transaction before suspension',
        );
        self::assertSame([1, 2], $afterResume, 'the owning fiber can read and nest its transaction after resuming');
        self::assertSame(Code::CONFIG, $error?->code_);
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
