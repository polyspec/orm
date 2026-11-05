<?php

// The generator recipe, contracts/fixtures/generator/generator.json, without a database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DBS-175, DSL-37, DSL-38, DSL-116, DSL-127, DSL-129, DSL-130, DSL-154, DBS-103, DBS-104, DBS-110,
// Requirements: DBS-173, INT-66, PLN-1, PLN-22.

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
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
