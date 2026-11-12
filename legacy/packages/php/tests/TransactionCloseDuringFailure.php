<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use RuntimeException;

trait TransactionCloseDuringFailure
{
    private function closeDuringTransaction(Db $db, RuntimeException $failure): ?RuntimeException
    {
        $caught = null;
        try {
            $db->transaction(static function () use ($db, $failure): void {
                $db->close();
                throw $failure;
            }, retry: 0);
        } catch (RuntimeException $error) {
            $caught = $error;
        }
        return $caught;
    }

    /**
     * Closes a SQLite Db on `$pdo` inside a transaction whose callback then fails, and checks what the close settles:
     * the callback failure survives, the statements that `$pdo` ran (`$statements`) are the row-lock table, BEGIN and
     * the ROLLBACK of the close, `$pdo` is out of its transaction, and the closed Db refuses another transaction with
     * CONFIG.
     *
     * @param \Closure(): list<string> $statements
     */
    private function assertCloseDuringTransactionRollsBack(PDO $pdo, \Closure $statements): void
    {
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $failure = new RuntimeException('the caller abandoned the transaction');
        try {
            Assert::assertSame(
                $failure,
                $this->closeDuringTransaction($db, $failure),
                'closing the connection preserves the callback failure'
            );
            Assert::assertSame(
                [
                    'CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))',
                    'BEGIN IMMEDIATE',
                    'ROLLBACK',
                ],
                $statements(),
                'close rolls back the active transaction before releasing the connection'
            );
            Assert::assertFalse($pdo->inTransaction(), 'the transaction is settled before close returns');
            $closed = null;
            try {
                $db->transaction(static function (): void {
                }, retry: 0);
            } catch (OrmException $error) {
                $closed = $error;
            }
            Assert::assertSame(Code::CONFIG, $closed?->code_, 'the closed connection cannot start another transaction');
        } finally {
            $db->close();
        }
    }
}
