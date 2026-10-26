<?php

// catalog_connection coverage exercises the PHP extension through its owning client test.
// Requirements: COD-31.
// Requirements: SCH-3, SCH-5, SCH-6, SCH-6a, DBS-113, INT-4, INT-8, INT-34, INT-97.
// Requirements: INT-101, INT-102, INT-103, INT-104, INT-106, INT-108, INT-109, INT-110.
// Requirements: INT-111, INT-112, INT-113, INT-114, INT-115, INT-121, INT-123, INT-136, INT-117.
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
        self::assertTrue((new \ReflectionClass(Catalog::class))->isInternal());
    }

    protected function assertModelImplementation(): void
    {
        self::assertTrue((new \ReflectionClass(Model::class))->isInternal());
    }

    // Requirements: INT-115.
    public function testCatalogPlainReadOnlyQueryBudgets(): void
    {
        self::assertTrue((new \ReflectionClass(Catalog::class))->isInternal());
        self::assertTrue((new \ReflectionMethod(Catalog::class, 'readOnlyQuery'))->isInternal());
        $this->assertPlainQueryBounds();
    }
}
