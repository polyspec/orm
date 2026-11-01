<?php

// The refused DSN recipe, contracts/fixtures/dsn_reject/dsn_reject.json, without a database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-2, CFG-17, CFG-19, CFG-26.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
class DsnRejectRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/dsn_reject/dsn_reject.json';
    }

    #[DataProvider('cases')]
    public function testNone(array $case): void
    {
        $this->runCase($case, Recipe::NONE);
    }
}
