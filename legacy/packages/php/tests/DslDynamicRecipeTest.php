<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The chain values that Go and Rust refuse at compile time, contracts/fixtures/dsl/dsl-dynamic.json, without a database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). Requirements: DSL-49, DSL-50, DSL-160, PLN-4.
#[Medium]
class DslDynamicRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/dsl/dsl-dynamic.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
