<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The refusal of an unknown dialect, tests/dbspec/dialect-refusal.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DBS-174.
#[Medium]
class DbspecDialectRefusalRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/dialect-refusal.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
