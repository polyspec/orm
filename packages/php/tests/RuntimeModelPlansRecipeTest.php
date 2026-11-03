<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The plans of the runtime model, tests/planner/runtime-model.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-112, PRT-32, PRT-81, PRT-82.
#[Medium]
class RuntimeModelPlansRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/planner/runtime-model.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
