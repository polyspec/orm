<?php

// The recipe contracts/fixtures/dsn_reject/dsn_reject_parameters.json without a database (docs/spec/feature-coverage.md
// FCV-3). Go and Rust pass another parameter to their drivers.
// Requirements: CFG-19, CFG-20, CFG-37.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DsnRejectParametersRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/dsn_reject/dsn_reject_parameters.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
