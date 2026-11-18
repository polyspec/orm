<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The test class of a recipe that runs on SQLite (docs/spec/feature-coverage.md FCV-22): a recipe test extends it and
 * names its recipe, and every case runs on SQLite as testSqlite.
 */
abstract class SqliteRecipeTestCase extends TestCase
{
    use RecipeCases;

    #[DataProvider('casesOnSqlite')]
    public function testSqlite(string $id): void
    {
        $this->runCase($id, 'sqlite');
    }
}
