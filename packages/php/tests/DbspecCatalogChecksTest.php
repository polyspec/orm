<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Dbspec\Catalog;
use Polyspec\Orm\Dbspec\CatalogChecks;
use Polyspec\Orm\Dbspec\CatalogTable;
use Polyspec\Orm\Dbspec\ColumnType;
use PHPUnit\Framework\TestCase;

final class DbspecCatalogChecksTest extends TestCase
{
    public function testCatalogCheckDecodesOrRecordsItsFailure(): void
    {
        $catalog = new Catalog();
        $table = new CatalogTable('users');
        $table->columns[] = [
            'name' => 'id',
            'type' => new ColumnType('i64'),
            'null' => false,
            'identity' => false,
            'default' => '',
        ];
        CatalogChecks::add($catalog, 'sqlite', $table, 'ck_users_sqlite', 'id > 0');
        CatalogChecks::add($catalog, 'postgres', $table, 'ck_users_postgres', 'CHECK (id > 0)');
        self::assertSame([
            ['name' => 'ck_users_sqlite', 'predicate' => 'id > 0'],
            ['name' => 'ck_users_postgres', 'predicate' => 'id > 0'],
        ], $table->checks);
        self::assertSame([], $catalog->unsupported);

        CatalogChecks::add($catalog, 'sqlite', $table, 'ck_users_bad_sqlite', 'id >');
        CatalogChecks::add($catalog, 'postgres', $table, 'ck_users_bad_postgres', 'CHECK (id >)');
        self::assertCount(2, $catalog->unsupported);
        foreach ($catalog->unsupported as $unsupported) {
            self::assertSame('check', $unsupported->kind);
            self::assertSame('users', $unsupported->table);
            self::assertNotSame('', $unsupported->reason);
        }
        self::assertSame(['ck_users_bad_sqlite', 'ck_users_bad_postgres'], array_map(
            static fn($unsupported): string => $unsupported->name,
            $catalog->unsupported
        ));
        self::assertCount(2, $table->checks);
    }
}
