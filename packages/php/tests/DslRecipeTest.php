<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The chain value recipe, contracts/fixtures/dsl/dsl.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DSL-49, DSL-50, PLN-4.
#[Medium]
class DslRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/dsl/dsl.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
