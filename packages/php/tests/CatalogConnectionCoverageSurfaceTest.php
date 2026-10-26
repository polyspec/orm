<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogColumn;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Code;
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

    public function testRowUpdateChecksDeclaredCharacterCapacityBeforeWriting(): void
    {
        $metadata = new CatalogTableMetadata(
            ['namespace' => 'main', 'name' => 'sample'],
            'table',
            [new CatalogColumn('name', 'varchar(191)', false, false, false, null, false)],
            [],
            false,
        );
        $changes = new \ReflectionMethod(Catalog::class, 'changes');

        self::assertSame(
            [[0, str_repeat('界', 191)]],
            $changes->invoke(null, $metadata, ['name' => str_repeat('界', 191)], Code::ROW_UPDATE_INVALID),
        );
        try {
            $changes->invoke(null, $metadata, ['name' => str_repeat('界', 192)], Code::ROW_UPDATE_INVALID);
            self::fail('an overlength multibyte value was accepted');
        } catch (\ReflectionException $error) {
            throw $error;
        } catch (\Throwable $error) {
            self::assertInstanceOf(\Polyspec\Orm\OrmException::class, $error);
            self::assertSame(Code::ROW_UPDATE_INVALID, $error->code_);
        }
    }
}
