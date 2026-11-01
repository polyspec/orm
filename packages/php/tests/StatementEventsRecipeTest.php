<?php

// The statement events recipe, contracts/fixtures/statement_events/statement_events.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-55, INT-77, INT-91, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13,
// FCV-14 (docs/spec/feature-coverage.md).
// Requirements: INT-55, INT-77, INT-91, INT-96.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class StatementEventsRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/statement_events/statement_events.json';
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
