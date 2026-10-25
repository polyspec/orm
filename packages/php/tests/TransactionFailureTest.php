<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDOException;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StatementEvent;
use PHPUnit\Framework\TestCase;

// Requirements: INT-72, DIA-181, PLN-17.
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

    // Requirements: INT-47.
    public function testAnotherFiberCannotUseAnActiveTransactionConnection(): void
    {
        $db = new Db(new \PDO('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
        $fiber = new \Fiber(static function () use ($db): void {
            $db->transaction(static function (): void {
                \Fiber::suspend();
            }, retry: 0);
        });
        $fiber->start();
        $error = null;
        try {
            $db->transaction(static fn() => null, retry: 0);
        } catch (OrmException $caught) {
            $error = $caught;
        } finally {
            $fiber->resume();
            $db->close();
        }
        self::assertSame(Code::CONFIG, $error?->code_);
    }

    public function testStatementFailureKeepsItsDriverCause(): void
    {
        $pdo = new ModelTestFailingPdo('sqlite::memory:');
        $pdo->exec('CREATE TABLE statement_failure (value INTEGER)');
        $pdo->exec("CREATE TRIGGER reject_statement_failure BEFORE INSERT ON statement_failure BEGIN "
            . "SELECT RAISE(ABORT, 'statement failure'); END");
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));

        try {
            try {
                $db->execute([
                    'sql' => 'INSERT INTO statement_failure (value) VALUES (1)',
                    'tables' => ['statement_failure'],
                    'bind_slots' => [],
                ], []);
                self::fail('the trigger must reject the statement');
            } catch (OrmException $error) {
                self::assertSame(Code::DRIVER, $error->code_);
                self::assertInstanceOf(PDOException::class, $error->getPrevious());
                self::assertStringContainsString('statement failure', $error->getMessage());
            }
        } finally {
            $db->close();
        }
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
}
