<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

require_once __DIR__ . '/StatementRunnerCases.php';

// Checks the statement runner of INT-150 on SQLite, MySQL, and PostgreSQL through the cases of StatementRunnerCases. Each case
// runs in its own case database (case_database.php), and ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN missing fails the test.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/StatementRunnerTest.php [--filter <case>]

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

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
