<?php

// The transactions recipe, contracts/fixtures/transactions/transactions.json, on each database
// (docs/spec/feature-coverage.md FCV-3). The recipe runs the CompositeAccount model of the bench set, so the external
// document of the set is installed first (docs/spec/dbspec.md "External documents").
// Requirements: DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-47,
// INT-48, PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class TransactionsRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/transactions/transactions.json';
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
