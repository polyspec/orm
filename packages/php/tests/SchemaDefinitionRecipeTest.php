<?php

// The schema definition recipe, tests/dbspec/schema-definition.json, without a database
// (docs/spec/feature-coverage.md FCV-4).
// Requirements: DBS-1, DBS-99, DBS-103, DBS-123, DBS-134, DBS-135, DBS-141, DBS-142, ORES-14.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class SchemaDefinitionRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/schema-definition.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
