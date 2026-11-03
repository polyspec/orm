<?php

// The signed public interface recipe, contracts/fixtures/public_interface/public_interface_signed.json (the signed limit, which Rust refuses at compile time), without a database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-159.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class PublicInterfaceSignedRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/public_interface/public_interface_signed.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
