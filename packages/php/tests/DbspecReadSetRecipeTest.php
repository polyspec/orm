<?php

// The set reader recipe, tests/dbspec/set-files.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-6, DBS-7, DBS-8, DBS-9, DBS-10, DBS-11, DBS-12, DBS-13, DBS-14, DBS-15, DBS-17, DBS-18, DBS-19,
// Requirements: DBS-20, DBS-21, DBS-22, DBS-23, DBS-24, DBS-25, DBS-26, ORES-20, ORES-28, ORES-29, ORES-30, ORES-31,
// Requirements: ORES-32, ORES-33, ORES-34, ORES-35, ORES-36.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DbspecReadSetRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/set-files.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
