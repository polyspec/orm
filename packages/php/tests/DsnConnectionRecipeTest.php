<?php

// The DSN connection recipe, contracts/fixtures/dsn_connection/dsn_connection.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, INT-13, CFG-19, CFG-2, CFG-26, CFG-16, DIA-57, DSL-141, CFG-27, CFG-28, CFG-29, CFG-6, CFG-12, CFG-13, CFG-21, CFG-22, CFG-23, CFG-25.
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
