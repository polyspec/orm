<?php

// The full-text search recipe, contracts/fixtures/fulltext_search/fulltext_search.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: DSL-32, DSL-33, DIA-6, DIA-187, PRT-75, FCV-4, FCV-9, FCV-10.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class FulltextSearchRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/fulltext_search/fulltext_search.json';
    }

    #[DataProvider('cases')]
    public function testMysql(array $case): void
    {
        $this->runCase($case, 'mysql');
    }

    #[DataProvider('cases')]
    public function testPostgres(array $case): void
    {
        $this->runCase($case, 'postgres');
    }

    #[DataProvider('cases')]
    public function testSqlite(array $case): void
    {
        $this->runCase($case, 'sqlite');
    }
}
