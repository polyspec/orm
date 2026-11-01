<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

require_once __DIR__ . '/../../php/tests/StatementRunnerTest.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\StatementRunnerCases;
use Polyspec\Orm\Tests\ThreeDrivers;
use Polyspec\Orm\TxFrame;
use ReflectionClass;
use function Polyspec\Orm\Tests\with_case_database;

// Checks the native statement runner of INT-150 on SQLite, MySQL, and PostgreSQL. The cases are the ones of the PHP runtime
// (Polyspec\Orm\Tests\StatementRunnerCases), and this file adds that the surface is native. Each case runs in its own case
// database, and a missing test server fails.
#[Medium]
final class StatementRunnerExtensionTest extends TestCase
{
    use ThreeDrivers;
    use StatementRunnerCases;

    private static function assertRunnerSurface(): void
    {
        $frame = new ReflectionClass(TxFrame::class);
        self::assertTrue($frame->hasMethod('run'), 'TxFrame::run is missing from the native extension');
        self::assertTrue($frame->getMethod('run')->isInternal(), 'TxFrame::run is not a native method');
        $utils = new ReflectionClass(\Polyspec\Orm\Utils::class);
        self::assertTrue($utils->getMethod('run')->isInternal(), 'Utils::run is not native');
    }

    // Requirements: INT-150.
    #[DataProvider('drivers')]
    public function testStatementRunnerOpensOrJoinsTransactionAndReturnsRows(string $driver): void
    {
        self::assertRunnerSurface();
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::runOutsideAndInside($dsn));
    }

    // Requirements: INT-150.
    #[DataProvider('drivers')]
    public function testStatementRunnerRefusesNonTextStatementWithConfig(string $driver): void
    {
        self::assertRunnerSurface();
        with_case_database($driver, static function (string $step): void {
        }, static fn(string $dsn) => self::nonTextStatementFailsWithConfig($dsn));
    }
}
