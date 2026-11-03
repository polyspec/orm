<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The default select set, tests/planner/default-select-set.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: PRT-9, DBS-68.
#[Medium]
class DefaultSelectSetRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/planner/default-select-set.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
