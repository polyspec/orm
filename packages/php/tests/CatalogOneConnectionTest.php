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
// alone (INT-157). A budget stop ends its query through the kill connection, which the catalog opens at that stop and
// keeps, so the processlist then shows the two, and a read after the stop opens no other (CFG-35).
// Requirements: INT-157, CFG-35.
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
                self::assertConnections(2, $catalog, 'a budget stop');
                $catalog->readOnlyQuery('SELECT seq FROM item');
                self::assertConnections(2, $catalog, 'a read after a budget stop');
            } finally {
                $catalog->close();
            }
        });
    }

    public function testMysqlCellsFollowTheirValuesWhenTheServerRefusesTheTypes(): void
    {
        with_case_database('mysql', static function (string $step): void {
        }, static function (string $dsn): void {
            $setup = Orm::connect($dsn, new Config());
            $database = (string) $setup->pdo()->query('SELECT DATABASE()')->fetchColumn();
            $setup->pdo()->exec("CREATE USER IF NOT EXISTS 'orm_no_temporary'@'%'");
            $setup->pdo()->exec("GRANT SELECT ON `$database`.* TO 'orm_no_temporary'@'%'");
            try {
                $restricted = preg_replace('#^mysql://[^@]+@#', 'mysql://orm_no_temporary@', $dsn);
                $catalog = Catalog::connect((string) $restricted);
                try {
                    $row = $catalog->readOnlyGridQuery(
                        "SELECT 1, COUNT(*), CAST(18446744073709551615 AS UNSIGNED), X'00FF', 'text' FROM DUAL"
                    )->rows[0];
                } finally {
                    $catalog->close();
                }
                self::assertSame(
                    [['integer', 1], ['integer', 1], ['unsigned', '18446744073709551615'], ['binary', "\x00\xFF"],
                        ['text', 'text']],
                    array_map(static fn ($cell): array => [$cell->kind, $cell->value], $row)
                );
            } finally {
                $setup->pdo()->exec("DROP USER 'orm_no_temporary'@'%'");
                $setup->close();
            }
        });
    }

    public function testMysqlGridQueryRefusesAStoredFunctionThatWrites(): void
    {
        with_case_database('mysql', static function (string $step): void {
        }, static function (string $dsn): void {
            $setup = Orm::connect($dsn, new Config());
            $setup->pdo()->exec('CREATE TABLE written (n INT) ENGINE=MyISAM');
            $setup->pdo()->exec(
                'CREATE FUNCTION writes() RETURNS INT DETERMINISTIC MODIFIES SQL DATA'
                . ' BEGIN INSERT INTO written VALUES (1); RETURN 1; END'
            );
            $catalog = Catalog::connect($dsn);
            try {
                $catalog->readOnlyGridQuery('SELECT writes()');
                self::fail('a grid query ran a stored function that writes');
            } catch (OrmException $refused) {
                self::assertSame(Code::QUERY_READ_ONLY, $refused->code_);
            } finally {
                $catalog->close();
            }
            self::assertSame(0, (int) $setup->pdo()->query('SELECT COUNT(*) FROM written')->fetchColumn());
            $setup->close();
        });
    }

    private static function assertOne(Catalog $catalog, string $after): void
    {
        self::assertConnections(1, $catalog, $after);
    }

    private static function assertConnections(int $count, Catalog $catalog, string $after): void
    {
        self::assertSame($count, self::connections($catalog), "the connections of the catalog's database after $after");
    }

    private static function connections(Catalog $catalog): mixed
    {
        return $catalog->readOnlyQuery(
            'SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = DATABASE()'
        )->rows[0][0];
    }
}
