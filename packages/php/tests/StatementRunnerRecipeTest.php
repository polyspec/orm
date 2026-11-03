<?php

// The statement runner recipe, contracts/fixtures/statement_runner/statement_runner.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-150, INT-77, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13,
// FCV-14 (docs/spec/feature-coverage.md).
// Requirements: INT-150, INT-77.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class StatementRunnerRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/statement_runner/statement_runner.json';
    }
}
