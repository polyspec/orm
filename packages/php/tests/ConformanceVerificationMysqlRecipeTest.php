<?php

// Requirements: PRT-77.
// The conformance_verification recipe, contracts/fixtures/conformance_verification/conformance_verification.json, on
// mysql (docs/spec/feature-coverage.md FCV-3 and FCV-4).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class ConformanceVerificationMysqlRecipeTest extends TestCase
{
    use RecipeCases;

    // The recipe peaks at 152.5 MB in this run: 106.5 MB of recipe and harness, and the 21846 models of
    // creates_batch_too_large, above the 128M default of PHP.
    public static function setUpBeforeClass(): void
    {
        if (ini_set('memory_limit', '256M') === false) {
            throw new \RuntimeException('the conformance_verification recipe requires its declared 256M memory_limit');
        }
    }

    protected static function recipe(): string
    {
        return 'contracts/fixtures/conformance_verification/conformance_verification.json';
    }

    #[DataProvider('cases')]
    public function testMysql(array $case): void
    {
        $this->runCase($case, 'mysql');
    }
}
