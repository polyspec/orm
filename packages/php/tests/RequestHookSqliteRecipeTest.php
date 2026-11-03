<?php

// Requirements: INT-78, PRT-2, PRT-65, DIA-161.

// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).

// The request hook recipe, contracts/fixtures/request_hook/request_hook.json, on SQLite (docs/spec/feature-coverage.md
// FCV-3 and FCV-4). Requirements: INT-78, PRT-2, PRT-4, PRT-5, PRT-6, PRT-41, CFG-21, INT-36, INT-37, PLN-16, DIA-161,
// INT-38.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class RequestHookSqliteRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/request_hook/request_hook.json';
    }

    #[DataProvider('cases')]
    public function testSqlite(array $case): void
    {
        $this->runCase($case, 'sqlite');
    }
}
