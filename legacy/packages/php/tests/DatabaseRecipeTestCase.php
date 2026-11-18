<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The test class of a recipe that runs on each database (docs/spec/feature-coverage.md FCV-22): a recipe test extends
 * it and names its recipe, and every case runs on MySQL, PostgreSQL and SQLite as testMysql, testPostgres and
 * testSqlite. The SQLite run is that of SqliteRecipeTestCase.
 */
abstract class DatabaseRecipeTestCase extends SqliteRecipeTestCase
{
    use RecipeCases;

    #[DataProvider('casesOnMysql')]
    public function testMysql(string $id): void
    {
        $this->runCase($id, 'mysql');
    }

    #[DataProvider('casesOnPostgres')]
    public function testPostgres(string $id): void
    {
        $this->runCase($id, 'postgres');
    }
}
