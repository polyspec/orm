<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// statement_runner coverage: the statement runner cases of StatementRunnerTest.php run on a new case database of the
// selected database (ORM_FEATURE_DATABASE). The bench database is neither read nor written. Requirements: INT-150.
#[Medium]
final class CoverageStatementRunnerTest extends TestCase
{
    use StatementRunnerCases;

    public function testStatementRunner(): void
    {
        self::coverStatementRunner(__FILE__);
    }
}
