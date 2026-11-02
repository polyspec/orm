<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The test class of a recipe that runs on each database (docs/spec/feature-coverage.md FCV-3): a recipe test extends
 * it and names its recipe, and every case runs on MySQL, PostgreSQL and SQLite as testMysql, testPostgres and
 * testSqlite.
 */
abstract class DatabaseRecipeTestCase extends TestCase
{
    use RecipeCases;

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testMysql(array $case): void
    {
        $this->runCase($case, 'mysql');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testPostgres(array $case): void
    {
        $this->runCase($case, 'postgres');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testSqlite(array $case): void
    {
        $this->runCase($case, 'sqlite');
    }
}
