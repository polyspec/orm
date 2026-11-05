<?php

// The planner compile recipe, tests/planner/compile.json, without a database (docs/spec/feature-coverage.md FCV-3).
// Requirements: COD-4, DIA-33, PRT-69, PRT-6, PRT-13, PRT-14, PRT-16, PRT-17, PRT-20, PRT-21, PRT-22, PRT-23, PRT-25,
// Requirements: PRT-31, PRT-32, PRT-33,
// Requirements: DSL-16, DSL-24, DSL-34, DSL-74, DSL-78, DSL-99, DSL-138, DSL-147, DSL-148, DIA-1, DIA-2, DIA-3, DIA-4,
// Requirements: DIA-5, DIA-7,
// Requirements: DIA-8, DIA-9, DIA-12, DIA-13, DIA-18, DIA-22, DIA-23, DIA-24, DIA-27, DIA-31, DIA-35, COD-43, PRT-7,
// Requirements: PRT-19, PRT-37,
// Requirements: PRT-67, PRT-78, DSL-95.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class PlannerCompileTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/planner/compile.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
