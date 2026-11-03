<?php

// The add tables steps of the recipe tests/dbspec/add-tables-steps.json, without a database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-56, SCH-8.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DbspecAddTablesStepsTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/add-tables-steps.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
