<?php

// The recipe contracts/fixtures/dsn_reject/dsn_reject_checked.json without a database (docs/spec/feature-coverage.md FCV-3).
// Rust passes the TLS options to its driver and its fields are unsigned.
// Requirements: CFG-4, CFG-5, CFG-6, CFG-18, CFG-36.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DsnRejectCheckedRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/dsn_reject/dsn_reject_checked.json';
    }

    #[DataProvider('cases')]
    public function testNone(string $id): void
    {
        $this->runCase($id, Recipe::NONE);
    }
}
