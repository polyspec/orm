<?php

// The composite_keys recipe, contracts/fixtures/composite_keys/composite_keys.json, on each database
// (docs/spec/feature-coverage.md FCV-3). The recipe runs the CompositeAccount and CompositeMembership models of the
// bench set.
// Requirements: DSL-82, INT-87, PRT-12, PRT-40.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class CompositeKeysRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/composite_keys/composite_keys.json';
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
