<?php

// catalog_connection coverage exercises the PHP library through its owning client test.
// Requirements: SCH-5, SCH-6a, INT-109, INT-113, INT-114, INT-123.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
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
}
