<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Tests\StatementRunnerCases;

// statement_runner coverage of the native extension: the statement runner cases of the PHP runtime run on a new case
// database of the selected database (ORM_FEATURE_DATABASE). The bench database is neither read nor written.
// Requirements: INT-150.
#[Medium]
final class CoverageStatementRunnerExtensionTest extends TestCase
{
    use StatementRunnerCases;

    public function testStatementRunner(): void
    {
        self::coverStatementRunner(__FILE__);
    }
}
