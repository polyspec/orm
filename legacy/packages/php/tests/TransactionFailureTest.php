<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\StatementEvent;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

// Requirements: INT-72, PLN-17.
#[\PHPUnit\Framework\Attributes\Medium]
final class TransactionFailureTest extends TestCase
{
    use TransactionFailureCases;
    use TransactionCloseDuringFailure;

    // Requirements: INT-67.
    public function testCloseDuringTransactionRollsBackAndPreservesCallbackFailure(): void
    {
        $pdo = new TransactionTrackingPdo();
        $this->assertCloseDuringTransactionRollsBack($pdo, static fn(): array => $pdo->statements);
    }

    // Requirements: DSL-121, DSL-122, INT-47, PLN-18.
    public function testAnotherFiberCannotUseAnActiveTransactionConnection(): void
    {
        $db = new Db(new \PDO('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
        try {
            $error = FiberTransaction::outsideError(FiberTransaction::holding($db), $db);
        } finally {
            $db->close();
        }
        self::assertSame(Code::CONFIG, $error?->code_);
    }

    public function testObservedStatementMetadataIsPreservedForObservedRunAndFetch(): void
    {
        $log = new StatementEventLog(new ModelTestFailingPdo('sqlite::memory:'));
        $db = $log->db;

        try {
            self::assertSame(
                'observed result',
                $db->observed(
                    StatementEvent::UTILITY,
                    ['sample'],
                    7,
                    'SELECT ?',
                    [17],
                    static fn(): string => 'observed result'
                )
            );
            $db->run(StatementEvent::SCHEMA, ['sample'], 7, 'CREATE TABLE sample (value INTEGER)');
            self::assertSame([['17']], $db->fetch(StatementEvent::UTILITY, ['sample'], 7, 'SELECT ? AS value', [17]));

            self::assertCount(3, $log->events);
            foreach ($log->events as $index => $event) {
                self::assertSame(
                    [
                        'sql' => ['SELECT ?', 'CREATE TABLE sample (value INTEGER)', 'SELECT ? AS value'][$index],
                        'binds' => [[17], [], [17]][$index],
                        'kind' => [StatementEvent::UTILITY, StatementEvent::SCHEMA, StatementEvent::UTILITY][$index],
                        'tables' => [['sample'], ['sample'], ['sample']][$index],
                        'transaction' => 7,
                        'error' => null,
                    ],
                    [
                        'sql' => $event->sql,
                        'binds' => $event->binds,
                        'kind' => $event->kind,
                        'tables' => $event->tables,
                        'transaction' => $event->transaction,
                        'error' => $event->error,
                    ]
                );
                self::assertGreaterThanOrEqual(0.0, $event->elapsed);
            }
        } finally {
            $log->close();
        }
    }

    // Requirements: CORE-24, INT-43, INT-48.
    // A deadlock is retried with no wait between the attempts: the test counts the calls of usleep while the
    // transaction runs and measures no time (FCV-2: the wait is visible only at this seam). The causes of the error
    // are the cases of the recipe transactions.
    public function testADeadlockIsRetriedWithNoWait(): void
    {
        $db = new Db(new \PDO('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
        $attempts = 0;
        $before = RetrySleepProbe::$calls;
        try {
            $db->transaction(static function () use (&$attempts): void {
                $attempts++;
                throw Orm::transactionConflict("attempt $attempts");
            }, retry: 2);
            self::fail('the retry runs out');
        } catch (OrmException $error) {
            self::assertSame(0, RetrySleepProbe::$calls - $before, 'no attempt waits before it runs');
            self::assertSame(3, $attempts, 'retry 2 runs the callback three times');
            self::assertSame(
                [Code::DEADLOCK, 'DEADLOCK: attempt 3'],
                [$error->code_, $error->getMessage()],
                'the error of the last attempt',
            );
        } finally {
            $db->close();
        }
    }
}
