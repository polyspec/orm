<?php

// The DSN connection recipe, contracts/fixtures/dsn_connection/dsn_connection.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, INT-13.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class DsnConnectionRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/dsn_connection/dsn_connection.json';
    }
}
