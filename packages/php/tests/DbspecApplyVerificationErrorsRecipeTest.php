<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// The apply verification errors of tests/dbspec/apply-verification-errors.json on a memory connection
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: PLN-92, PLN-93, PLN-96, PLN-98, PLN-106.
#[Medium]
class DbspecApplyVerificationErrorsRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'tests/dbspec/apply-verification-errors.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
