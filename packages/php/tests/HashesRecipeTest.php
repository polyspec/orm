<?php

// The dbspec manifest hash recipe, tests/dbspec/hashes.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
// Requirements: DBS-65, ORES-16, DBS-86, DBS-94, DBS-99, DBS-100, DBS-102, DBS-103, DIA-97.
// Requirements: ORES-13.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class HashesRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/hashes.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
