<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/CatalogConnectionCoverageCases.php';
require_once __DIR__ . '/StatementEventsCoverageCases.php';

#[Small]
final class CatalogConnectionCoverageSurfaceTest extends TestCase
{
    public function test_library_catalog_is_a_php_class_and_shared_cases_are_declared(): void
    {
        self::assertFalse((new \ReflectionClass(Catalog::class))->isInternal());
        $methods = array_map(
            static fn(\ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(CatalogConnectionCoverageCases::class))->getMethods(),
        );
        self::assertContains('test_catalog_read', $methods);
        self::assertContains('test_catalog_row_mutation', $methods);
        $eventMethods = array_map(
            static fn(\ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(StatementEventsCoverageCases::class))->getMethods(),
        );
        self::assertContains('test_statement_events', $eventMethods);
    }
}
