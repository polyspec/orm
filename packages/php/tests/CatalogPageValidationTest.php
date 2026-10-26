<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogColumn;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

#[Small]
final class CatalogPageValidationTest extends TestCase
{
    // Requirements: INT-121.
    public function testRejectsPreparedColumnAndDescriptorChanges(): void
    {
        $before = new CatalogTableMetadata(
            ['namespace' => 'main', 'name' => 'page_probe'],
            'table',
            [new CatalogColumn('id', 'INTEGER', false, false, false, null, false)],
            ['id'],
            true,
        );
        $changed = new CatalogTableMetadata(
            $before->table,
            'table',
            [new CatalogColumn('id', 'INTEGER', true, false, false, null, false)],
            ['id'],
            true,
        );

        $matches = new \ReflectionMethod(Catalog::class, 'samePageDescriptor');
        self::assertFalse($matches->invoke(null, $changed, $before));

        $sameNames = new \ReflectionMethod(Catalog::class, 'sameNames');
        try {
            $sameNames->invoke(null, ['renamed'], $before, Code::TABLE_PAGE_METADATA_CHANGED);
            self::fail('prepared columns that differ from the descriptor were accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::TABLE_PAGE_METADATA_CHANGED, $error->code_);
        }
    }
}
