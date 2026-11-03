<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
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
            $catalog = Catalog::connect($dsn);
            try {
                self::assertOne($setup, 'connect');
                $catalog->readOnlyQuery('SELECT seq FROM item');
                self::assertOne($setup, 'readOnlyQuery');
                $catalog->readOnlyGridQuery('SELECT seq FROM item');
                self::assertOne($setup, 'readOnlyGridQuery');
                try {
                    $catalog->readOnlyGridQuery('SELECT seq FROM item', [], 1);
                    self::fail('a stopped grid query returned a result');
                } catch (OrmException $stop) {
                    self::assertSame(Code::CATALOG_LIMIT, $stop->code_);
                }
                self::assertOne($setup, 'a budget stop');
            } finally {
                $catalog->close();
            }
            $setup->close();
        });
    }

    // CFG-35: a budget stop returns without reading the rest of the result. A user whose second connection the server
    // refuses cannot kill its statement, so the statement must not start: 100 rows at 0.2 s each would hold the read
    // for 20 s.
    public function testMysqlReadThatCouldNotBeStoppedDoesNotReadTheRest(): void
    {
        with_case_database('mysql', static function (string $step): void {
        }, static function (string $dsn): void {
            $setup = Orm::connect($dsn, new Config());
            $database = (string) $setup->pdo()->query('SELECT DATABASE()')->fetchColumn();
            $setup->pdo()->exec('CREATE TABLE item (seq INT PRIMARY KEY)');
            $setup->pdo()->exec(
                'INSERT INTO item WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)'
                . ' SELECT i FROM n'
            );
            $setup->pdo()->exec("CREATE USER IF NOT EXISTS 'orm_one_connection'@'%' WITH MAX_USER_CONNECTIONS 1");
            $setup->pdo()->exec("GRANT SELECT ON `$database`.* TO 'orm_one_connection'@'%'");
            try {
                $restricted = (string) preg_replace('#^mysql://[^@]+@#', 'mysql://orm_one_connection@', $dsn);
                $sql = "SELECT SLEEP(0.2), REPEAT('x', 20000) FROM item";
                $catalog = Catalog::connect($restricted);
                try {
                    foreach (['readOnlyQuery', 'readOnlyGridQuery'] as $read) {
                        $began = microtime(true);
                        try {
                            $catalog->$read($sql, [], 1);
                            self::fail("$read returned a result past its budget");
                        } catch (OrmException $stop) {
                            self::assertSame(Code::CONFIG, $stop->code_, $read);
                        }
                        self::assertLessThan(5.0, microtime(true) - $began, "$read read the rest of its result");
                    }
                } finally {
                    $catalog->close();
                }
            } finally {
                $setup->pdo()->exec("DROP USER IF EXISTS 'orm_one_connection'@'%'");
                $setup->close();
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

    // A read of the catalog opens a second connection for its stop (CFG-35), so another connection counts what the catalog
    // holds between its operations. The server ends a closed connection after the close returns and sends no notice of it,
    // so the count has the 2 s of CFG-35 to reach one.
    private static function assertOne(Db $observer, string $after): void
    {
        $deadline = microtime(true) + 2.0;
        do {
            $count = (int) $observer->pdo()->query(
                'SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID()'
            )->fetchColumn();
        } while ($count !== 1 && microtime(true) < $deadline);
        self::assertSame(1, $count, "the connections of the catalog's database after $after");
    }
}
