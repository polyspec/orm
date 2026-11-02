<?php

// The generator scan recipe, contracts/fixtures/generator_scan/generator_scan.json, without a database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-44, DSL-151, DSL-152.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class GeneratorScanTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/generator_scan/generator_scan.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
