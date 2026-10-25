<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class CatalogConnectionCoverageSurfaceTest extends TestCase
{
    public function testLibraryCatalogIsAPhpClassAndSharedCasesAreDeclared(): void
    {
        self::assertFalse((new \ReflectionClass(Catalog::class))->isInternal());
        $methods = array_map(
            static fn(\ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(CatalogConnectionCoverageCases::class))->getMethods(),
        );
        self::assertContains('testCatalogRead', $methods);
        self::assertContains('testCatalogRowMutation', $methods);
        $eventMethods = array_map(
            static fn(\ReflectionMethod $method): string => $method->getName(),
            (new \ReflectionClass(StatementEventsCoverageCases::class))->getMethods(),
        );
        self::assertContains('testStatementEvents', $eventMethods);
    }
}
