<?php

// Requirements: INT-103

// The catalog connection sqlite-only recipe, contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json,
// on SQLite and flowmark (docs/spec/feature-coverage.md FCV-3).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class CatalogConnectionSqliteOnlyRecipeTest extends SqliteRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json';
    }
}
