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
        $entries = array_map(
            static fn(ReflectionMethod $method): string => $method->getName(),
            (new ReflectionClass(CatalogConnectionRecipeTest::class))->getMethods(),
        );
        self::assertContains('testMysql', $entries);
        self::assertContains('testPostgres', $entries);
        self::assertContains('testSqlite', $entries);
        $eventCases = array_map(
            static fn(ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(StatementEventsCoverageCases::class))->getMethods(),
        );
        self::assertContains('testStatementEvents', $eventCases);
        self::assertFileExists(__DIR__ . '/../../php/tests/CoverageCatalogConnectionTest.php');
        self::assertFileExists(__DIR__ . '/CoverageStatementEventsTest.php');
        self::assertFileExists(__DIR__ . '/CoverageSchemaDefinitionExtensionTest.php');
    }
}
