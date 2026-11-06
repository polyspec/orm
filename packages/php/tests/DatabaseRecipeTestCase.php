<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The test class of a recipe that runs on each database (docs/spec/feature-coverage.md FCV-3): a recipe test extends
 * it and names its recipe, and every case runs on MySQL, PostgreSQL, SQLite and flowmark as testMysql, testPostgres,
 * testSqlite and testMarkdown; a markdown connection runs the cases that SQLite runs (DIA-154). The SQLite and flowmark
 * runs are those of SqliteRecipeTestCase.
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
