<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// Checks the statement runner of INT-150 on SQLite, MySQL, and PostgreSQL through the cases of StatementRunnerCases. Each case
// runs in its own case database (case_database.php), and ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN missing fails the test.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/StatementRunnerTest.php [--filter <case>]

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
            Assert::assertSame(1, self::firstNumber($outside), 'Utils::run outside a transaction did not return the rows of SELECT 1');
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
            Assert::assertSame(1, self::firstNumber($joined), 'Utils::run inside a transaction did not return the rows of SELECT 1');
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
}

#[Medium]
final class StatementRunnerTest extends TestCase
{
    use ThreeDrivers;
    use StatementRunnerCases;

    #[DataProvider('drivers')]
    public function testStatementRunner(string $driver): void
    {
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::runOutsideAndInside($dsn));
    }

    #[DataProvider('drivers')]
    public function testStatementRunnerNonText(string $driver): void
    {
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::nonTextStatementFailsWithConfig($dsn));
    }
}
