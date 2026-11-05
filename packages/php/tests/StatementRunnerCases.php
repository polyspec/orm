<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Assert;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\StatementEvent;
use Polyspec\Orm\TxFrame;

/** The refusals of INT-150a and INT-150b that the statement runner tests of the library and of the extension share. */
trait StatementRunnerCases
{
    /** Runs a case on its own case database, whose creation steps nothing reports. */
    private static function onCaseDatabase(string $driver, callable $case): void
    {
        with_case_database($driver, static function (string $step): void {
        }, $case);
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
            Assert::assertSame(
                Code::CONFIG,
                $failure->code_,
                'a frame after its transaction ended did not fail with CONFIG'
            );
            Assert::assertSame(0, $statements, 'a frame after its transaction ended sent a statement');
        } finally {
            $db->close();
        }
    }
}
