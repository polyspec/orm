<?php

// Requirements: INT-107, COD-31, INT-4, INT-8

// The catalog connection recipe, contracts/fixtures/catalog_connection/catalog_connection.json, on each database
// (docs/spec/feature-coverage.md FCV-3).
// Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123,
// INT-136, SCH-6a.
// Requirements: DBS-113, INT-34, INT-102, INT-106, INT-108, INT-110, INT-112, SCH-5.
// Requirements: SCH-3.
// Requirements: INT-97.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;

#[Medium]
class CatalogConnectionRecipeTest extends DatabaseRecipeTestCase
{
    protected static function recipe(): string
    {
        return 'contracts/fixtures/catalog_connection/catalog_connection.json';
    }
}
