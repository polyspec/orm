<?php

// The dbspec_apply recipe, contracts/fixtures/dbspec_apply/dbspec_apply.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: PLN-89, PLN-90, PLN-91, PLN-92, PLN-93, PLN-94, PLN-95, PLN-96, PLN-104, PLN-105.

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class DbspecApplyRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/dbspec_apply/dbspec_apply.json';
    }
}
