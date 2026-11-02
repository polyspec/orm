<?php

// The set-parse recipe, tests/dbspec/set-parse.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-2, DBS-28, DBS-29, DBS-30, DBS-31, DBS-156, DBS-168, DBS-171.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DbspecSetParseRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/set-parse.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
