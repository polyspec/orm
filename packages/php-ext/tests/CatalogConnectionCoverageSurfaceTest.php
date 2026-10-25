<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\Code;
use ReflectionClass;
use ReflectionMethod;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class CatalogConnectionCoverageSurfaceTest extends TestCase
{
    public function testNativeCatalogIsInternalAndOwnsSharedCases(): void
    {
        self::assertTrue((new ReflectionClass(Catalog::class))->isInternal());
        self::assertSame(Code::ROW_INSERT_IDENTITY_REQUIRED, 'ROW_INSERT_IDENTITY_REQUIRED');
        self::assertSame(Code::ROW_INSERT_UNSUPPORTED, 'ROW_INSERT_UNSUPPORTED');
        $catalogCases = array_map(
            static fn(ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(CatalogConnectionCoverageCases::class))->getMethods(),
        );
        self::assertContains('testCatalogRead', $catalogCases);
        self::assertContains('testCatalogRowMutation', $catalogCases);
        $eventCases = array_map(
            static fn(ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(StatementEventsCoverageCases::class))->getMethods(),
        );
        self::assertContains('testStatementEvents', $eventCases);
        self::assertFileExists(__DIR__ . '/CoverageCatalogConnectionTest.php');
        self::assertFileExists(__DIR__ . '/CoverageStatementEventsTest.php');
        self::assertFileExists(__DIR__ . '/CoverageSchemaDefinitionExtensionTest.php');
    }
}
