<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The entities of the runtime model, tests/dbspec/runtime-model.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-65, DBS-85, DBS-111, DBS-112.
#[Medium]
class RuntimeModelEntitiesRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/runtime-model.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
