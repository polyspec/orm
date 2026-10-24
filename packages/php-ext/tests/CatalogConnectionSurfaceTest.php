<?php

declare(strict_types=1);

// DB-free native tests for the Catalog DTOs and the extension's public connection boundary.

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Small;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogColumn;
use Polyspec\Orm\CatalogGridCell;
use Polyspec\Orm\CatalogResult;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\CatalogTablePage;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

#[Small]
final class CatalogConnectionSurfaceTest extends TestCase
{
    public function test_native_grid_cells_preserve_declared_values(): void
    {
        $values = [
            ['null', null],
            ['integer', -7],
            ['unsigned', '18446744073709551615'],
            ['float32', '80000000'],
            ['float64', '7ff8000000000000'],
            ['decimal', '123.4500'],
            ['text', 'text'],
            ['boolean', true],
            ['binary', "\x00\xff"],
            ['date', '2026-10-24'],
            ['time', '12:34:56.123456'],
            ['datetime', '2026-10-24 12:34:56.123456'],
        ];
        foreach ($values as [$kind, $value]) {
            $cell = new CatalogGridCell($kind, $value);
            self::assertSame($kind, $cell->kind);
            self::assertSame($value, $cell->value);
        }
    }

    public function test_native_table_page_indexes_columns_and_reports_unknown_name(): void
    {
        $columns = [
            new CatalogColumn('id', 'BIGINT', false, false, true, null, false),
            new CatalogColumn('value', 'TEXT', true, false, false, null, false),
        ];
        $metadata = new CatalogTableMetadata(
            ['namespace' => 'main', 'name' => 'sample'],
            'table',
            $columns,
            ['id'],
            true,
        );
        $page = new CatalogTablePage($metadata, new CatalogResult(['id', 'value'], []), 20, 0, ['id'], false);
        self::assertSame(0, $page->columnIndex('id'));
        self::assertSame(1, $page->columnIndex('value'));
        try {
            $page->columnIndex('missing');
            self::fail('an unknown catalog column was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNKNOWN, $error->code_);
        }
    }

    public function test_native_connect_rejects_non_database_dsn(): void
    {
        self::assertTrue((new \ReflectionClass(Catalog::class))->isInternal());
        try {
            Catalog::connect('markdown://corpus');
            self::fail('a non-database DSN created a catalog connection');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
        }
    }

    public function test_native_close_attempts_both_steps_and_keeps_primary_and_cleanup_causes(): void
    {
        $db = new Db(null, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $state = (new ReflectionProperty(Db::class, 'state'))->getValue($db);
        $statement = new class {
            public function closeCursor(): void
            {
                throw new RuntimeException('database cleanup failed');
            }
        };
        (new ReflectionProperty($state, 'stmts'))->setValue($state, [$statement]);

        $catalog = (new ReflectionClass(Catalog::class))->newInstanceWithoutConstructor();
        (new ReflectionProperty(Catalog::class, 'db'))->setValue($catalog, $db);
        (new ReflectionProperty(Catalog::class, 'dialect'))->setValue($catalog, 'sqlite');
        $grid = (new ReflectionClass(mysqli::class))->newInstanceWithoutConstructor();
        (new ReflectionProperty(Catalog::class, 'gridLink'))->setValue($catalog, $grid);

        try {
            $catalog->close();
            self::fail('both cleanup failures were ignored');
        } catch (OrmException $error) {
            self::assertSame(Code::DRIVER, $error->code_);
            self::assertInstanceOf(Error::class, $error->getPrevious());
            self::assertCount(1, $error->cleanup);
            self::assertInstanceOf(RuntimeException::class, $error->cleanup[0]);
            self::assertSame('database cleanup failed', $error->cleanup[0]->getMessage());
        }

        $catalog->close();
        self::assertSame('sqlite', $catalog->dialect());
        try {
            $catalog->readOnlyQuery('SELECT 1');
            self::fail('a read operation after close reached the database');
        } catch (OrmException $error) {
            self::assertSame(Code::CATALOG_CLOSED, $error->code_);
        }
    }
}
