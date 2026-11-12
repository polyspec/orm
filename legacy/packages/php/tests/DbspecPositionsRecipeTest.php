<?php

// The positions recipe, tests/dbspec/positions.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-140, DBS-142, DBS-143, ORES-12, ORES-57, ORES-58, ORES-59, ORES-60, ORES-61, ORES-62, ORES-63,
// Requirements: ORES-66, ORES-67, ORES-68, ORES-69, ORES-71, ORES-72.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DbspecPositionsRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/positions.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
