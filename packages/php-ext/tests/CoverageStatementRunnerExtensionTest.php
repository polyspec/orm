<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

require_once __DIR__ . '/../../php/tests/StatementRunnerTest.php';

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\StatementRunnerCases;
use function Polyspec\Orm\Tests\with_case_database;

// statement_runner coverage of the native extension: the statement runner cases of the PHP runtime run on a new case database
// of the selected database (ORM_FEATURE_DATABASE). The bench database is neither read nor written.
// Requirements: INT-150.
#[Medium]
final class CoverageStatementRunnerExtensionTest extends TestCase
{
    use StatementRunnerCases;

    public function testStatementRunner(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            [$driver] = coverageItem();
            with_case_database($driver, static function (string $step): void {
            }, static fn(string $dsn) => self::runOutsideAndInside($dsn));
            with_case_database($driver, static function (string $step): void {
            }, static fn(string $dsn) => self::nonTextStatementFailsWithConfig($dsn));
        }
    }
}
