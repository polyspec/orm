<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDOException;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\TestCase;
use RuntimeException;

// Requirements: INT-72, DIA-181, PLN-17.
final class TransactionFailureTest extends TestCase
{
    use TransactionFailureCases;
    use TransactionCloseDuringFailure;

    // Requirements: INT-67.
    public function testCloseDuringTransactionRollsBackAndPreservesCallbackFailure(): void
    {
        $pdo = new TransactionTrackingPdo();
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $failure = new RuntimeException('the caller abandoned the transaction');

        try {
            $caught = $this->closeDuringTransaction($db, $failure);

            self::assertSame($failure, $caught, 'closing the connection preserves the callback failure');
            self::assertSame([
                'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))',
                'BEGIN IMMEDIATE',
                'ROLLBACK',
            ], $pdo->statements, 'close rolls back before releasing the connection');
            self::assertFalse($pdo->inTransaction(), 'the active transaction is settled');

            try {
                $db->transaction(
                    static function (): void {
                    },
                    retry: 0
                );
                self::fail('the disposed connection must reject another transaction');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
            }
        } finally {
            $db->close();
        }
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
}
