<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\TxFrame;
use RuntimeException;

/** The statement runner cases of INT-150 that the statement runner tests share. */
trait StatementRunnerCases
{
    /** The first column of the first row of a statement result, as an int. */
    private static function firstNumber(array $rows): int
    {
        if (!isset($rows[0][0])) {
            throw new RuntimeException('the statement returned no row');
        }
        return (int) $rows[0][0];
    }

    /** Runs SELECT 1 through the frame outside a transaction, where the runner opens one, and inside one, where it joins it. */
    private static function runOutsideAndInside(string $dsn): void
    {
        $db = Orm::connect($dsn, new Config());
        try {
            $opened = null;
            $outside = $db->utils()->run(function (TxFrame $frame) use ($db, &$opened): array {
                $opened = $frame->number === $db->transactionNumber();
                return $frame->run(StatementEvent::UTILITY, [], 'SELECT 1');
            });
            Assert::assertTrue($opened === true, 'Utils::run outside a transaction did not open the frame of one');
            Assert::assertSame(
                1,
                self::firstNumber($outside),
                'Utils::run outside a transaction did not return the rows of SELECT 1'
            );
            Assert::assertNull($db->transactionNumber(), 'Utils::run outside a transaction left its transaction open');

            $outer = null;
            $joined = null;
            $db->transaction(function () use ($db, &$outer, &$joined): void {
                $outer = Db::activeFor($db);
                $joined = $db->utils()->run(function (TxFrame $frame) use ($outer): array {
                    Assert::assertSame($outer, $frame, 'Utils::run inside a transaction did not join it');
                    return $frame->run(StatementEvent::UTILITY, [], 'SELECT 1');
                });
            }, retry: 0);
            Assert::assertNotNull($outer, 'the outer transaction has no frame');
            Assert::assertSame(
                1,
                self::firstNumber($joined),
                'Utils::run inside a transaction did not return the rows of SELECT 1'
            );
            Assert::assertNull($db->transactionNumber(), 'the outer transaction was left open');
        } finally {
            $db->close();
        }
    }

    /** A statement that is not text fails with CONFIG, and the runner ends the transaction it opened. */
    private static function nonTextStatementFailsWithConfig(string $dsn): void
    {
        $db = Orm::connect($dsn, new Config());
        try {
            $failure = null;
            try {
                $db->utils()->run(fn(TxFrame $frame): array => $frame->run(StatementEvent::UTILITY, [], 123));
            } catch (OrmException $e) {
                $failure = $e;
            }
            Assert::assertNotNull($failure, 'a statement that is not text did not fail');
            Assert::assertSame(Code::CONFIG, $failure->code_, 'a statement that is not text did not fail with CONFIG');
            Assert::assertNull($db->transactionNumber(), 'the failed runner left its transaction open');
        } finally {
            $db->close();
        }
    }

    /** A frame used after its transaction ended fails with CONFIG and sends no statement. */
    private static function frameAfterItsTransactionEndedFailsWithConfig(string $dsn): void
    {
        $db = Orm::connect($dsn, new Config());
        try {
            $kept = null;
            $db->utils()->run(function (TxFrame $frame) use (&$kept): void {
                $kept = $frame;
            });
            $statements = 0;
            $stop = $db->subscribe(static function () use (&$statements): void {
                $statements++;
            });
            $failure = null;
            try {
                $kept->run(StatementEvent::UTILITY, [], 'SELECT 1');
            } catch (OrmException $e) {
                $failure = $e;
            }
            $stop();
            Assert::assertNotNull($failure, 'a frame after its transaction ended ran a statement');
            Assert::assertSame(Code::CONFIG, $failure->code_, 'a frame after its transaction ended did not fail with CONFIG');
            Assert::assertSame(0, $statements, 'a frame after its transaction ended sent a statement');
        } finally {
            $db->close();
        }
    }
}
