<?php

declare(strict_types=1);

use Polyspec\Orm\Catalog;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class CatalogConnectionCoverageSurfaceTest extends TestCase
{
    public function test_native_catalog_is_internal_and_owns_shared_cases(): void
    {
        self::assertTrue((new ReflectionClass(Catalog::class))->isInternal());
        $catalogCases = array_map(
            static fn(ReflectionMethod $method): string => $method->getName(),
            (new ReflectionClass(Polyspec\Orm\Tests\CatalogConnectionCoverageCases::class))->getMethods(),
        );
        self::assertContains('test_catalog_read', $catalogCases);
        self::assertContains('test_catalog_row_mutation', $catalogCases);
        $eventCases = array_map(
            static fn(ReflectionMethod $method): string => $method->getName(),
            (new ReflectionClass(Polyspec\Orm\Tests\StatementEventsCoverageCases::class))->getMethods(),
        );
        self::assertContains('test_statement_events', $eventCases);
        self::assertFileExists(__DIR__ . '/CoverageCatalogConnectionTest.php');
        self::assertFileExists(__DIR__ . '/CoverageStatementEventsTest.php');
        self::assertFileExists(__DIR__ . '/CoverageSchemaDefinitionExtensionTest.php');
    }
}
