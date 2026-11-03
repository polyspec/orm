<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

// A MySQL catalog of PHP holds one connection, PDO, across every operation: the processlist of its database shows it
// alone (INT-157). A budget stop ends its query through a connection that closes with the stop.
// Requirements: INT-157.
#[Medium]
class CatalogOneConnectionTest extends TestCase
{
    public function testMysqlCatalogHoldsOneConnection(): void
    {
        with_case_database('mysql', static function (string $step): void {
        }, static function (string $dsn): void {
            $setup = Orm::connect($dsn, new Config());
            $setup->pdo()->exec('CREATE TABLE item (seq INT PRIMARY KEY)');
            $setup->pdo()->exec(
                'INSERT INTO item WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)'
                . ' SELECT i FROM n'
            );
            $setup->close();
            $catalog = Catalog::connect($dsn);
            try {
                self::assertOne($catalog, 'connect');
                $catalog->readOnlyQuery('SELECT seq FROM item');
                self::assertOne($catalog, 'readOnlyQuery');
                $catalog->readOnlyGridQuery('SELECT seq FROM item');
                self::assertOne($catalog, 'readOnlyGridQuery');
                try {
                    $catalog->readOnlyGridQuery('SELECT seq FROM item', [], 1);
                    self::fail('a stopped grid query returned a result');
                } catch (OrmException $stop) {
                    self::assertSame(Code::CATALOG_LIMIT, $stop->code_);
                }
                self::assertOne($catalog, 'a budget stop');
            } finally {
                $catalog->close();
            }
        });
    }

    private static function assertOne(Catalog $catalog, string $after): void
    {
        $rows = $catalog->readOnlyQuery(
            'SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = DATABASE()'
        )->rows;
        self::assertSame(1, $rows[0][0], "the connections of the catalog's database after $after");
    }
}
