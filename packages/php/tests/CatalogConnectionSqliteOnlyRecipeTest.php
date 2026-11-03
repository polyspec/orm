<?php

// Requirements: INT-103

// The catalog connection sqlite-only recipe, contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json,
// on SQLite (docs/spec/feature-coverage.md FCV-3).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class CatalogConnectionSqliteOnlyRecipeTest extends TestCase
{
    use RecipeCases;

    protected static function recipe(): string
    {
        return 'contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json';
    }

    #[DataProvider('cases')]
    public function testSqlite(string $id): void
    {
        $this->runCase($id, 'sqlite');
    }
}
