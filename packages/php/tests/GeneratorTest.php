<?php

// The generator recipe, contracts/fixtures/generator/generator.json, without a database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-37, DSL-116, DSL-127, DSL-129, DSL-130, PLN-22.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class GeneratorTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/generator/generator.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
