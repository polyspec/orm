<?php

// The conformance_verification recipe, contracts/fixtures/conformance_verification/conformance_verification.json, on
// sqlite (docs/spec/feature-coverage.md FCV-3 and FCV-4).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class ConformanceVerificationSqliteRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/conformance_verification/conformance_verification.json';
    }

    #[DataProvider('cases')]
    public function testSqlite(array $case): void
    {
        $this->runCase($case, 'sqlite');
    }
}
