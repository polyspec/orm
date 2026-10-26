<?php

// catalog_connection coverage exercises the PHP library through its owning client test.
// Requirements: COD-31.
// Requirements: SCH-3, SCH-5, SCH-6, SCH-6a, DBS-113, INT-4, INT-8, INT-34, INT-97, INT-101, INT-102, INT-103, INT-104, INT-106.
// Requirements: INT-108, INT-109, INT-110, INT-111, INT-112, INT-113, INT-114, INT-115, INT-121, INT-123, INT-136.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\Model;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageCatalogConnectionTest extends TestCase
{
    use CatalogConnectionCoverageCases;

    protected function assertCatalogImplementation(): void
    {
        self::assertFalse((new \ReflectionClass(Catalog::class))->isInternal());
    }

    protected function assertModelImplementation(): void
    {
        self::assertFalse((new \ReflectionClass(Model::class))->isInternal());
    }

    // Requirements: INT-115.
    public function testCatalogPlainReadOnlyQueryBudgets(): void
    {
        $this->assertPlainQueryBounds();
    }
}
