<?php

// Requirements: INT-107, COD-31, INT-4, INT-8

// The catalog connection recipe, contracts/fixtures/catalog_connection/catalog_connection.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
// Requirements: DBS-113, INT-34, INT-102, INT-106, INT-108, INT-110, INT-112, SCH-5.
// Requirements: SCH-3.
// Requirements: CFG-28, CFG-41.
// Requirements: INT-97.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class CatalogConnectionRecipeTest extends DatabaseRecipeTestCase
{
    // row_baseline_rejected holds about four live copies of its 14,680,064-byte cell: alone on SQLite it passes with
    // 56M above what the process holds at the start of the class and fails with 48M (Allowed memory size exhausted in
    // Catalog.php), so the class states 64M; the extension twin inherits it.
    public static function setUpBeforeClass(): void
    {
        requireMemoryBudget('64M', 'the recipe ' . static::recipe());
    }

    protected static function recipe(): string
    {
        return 'contracts/fixtures/catalog_connection/catalog_connection.json';
    }
}
