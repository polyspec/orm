<?php

// The document set recipe, tests/dbspec/sets.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-30, DBS-35, DBS-99, DBS-101, DBS-105, DBS-106, DBS-168.
// Requirements: ORES-13.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class SetsRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/sets.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
