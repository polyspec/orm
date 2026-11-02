<?php

// The performance gate correctness recipe, contracts/fixtures/performance_gate/performance_gate.json, on each database
// (docs/spec/feature-coverage.md FCV-3, FCV-4). The timing of the gate stays in the performance coverage cases.
// Requirements: PERF-1.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class PerformanceGateRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/performance_gate/performance_gate.json';
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
