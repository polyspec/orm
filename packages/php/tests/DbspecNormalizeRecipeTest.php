<?php

// The normalize recipe, tests/dbspec/normalize.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-2, DBS-36, DBS-45, DBS-47, DBS-49, DBS-69, DBS-71, DBS-123, DBS-124, DBS-125, DBS-126, DBS-127,
// Requirements: DBS-128, DBS-129, DBS-130, DBS-131, DBS-132.
// Requirements: ORES-13.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DbspecNormalizeRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/normalize.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
