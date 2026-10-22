<?php

// catalog_connection coverage (Requirements: SCH-5, SCH-6a): runs the two shared cases against the bench database that
// the feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through Catalog::connect. The read case only
// reads; the mutation case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the
// state it started in.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogGridCell;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageCatalogConnectionTest extends TestCase
{
    private const TENANT = 990005;

    private string $driver = '';
    private ?Catalog $catalog = null;

    protected function setUp(): void
    {
        $this->driver = (string) getenv('ORM_FEATURE_DATABASE');
        self::assertContains(
            $this->driver,
            ['mysql', 'postgres', 'sqlite'],
            'ORM_FEATURE_DATABASE is required; run it through make feature-check'
        );
        $this->catalog = Catalog::connect((string) getenv('ORM_FEATURE_DSN'));
        self::assertSame($this->driver, $this->catalog->dialect(), 'ORM_FEATURE_DSN selects another database');
    }

    protected function tearDown(): void
    {
        $this->catalog?->close();
    }

    private function quote(string $name): string
    {
        return $this->driver === 'mysql' ? "`{$name}`" : "\"{$name}\"";
    }

    public function testRead(): void
    {
        $namespace = $this->catalog->currentNamespace();
        $author = ['namespace' => $namespace, 'name' => 'author'];
        $meta = $this->catalog->describeTable($author);
        self::assertSame(['seq'], $meta->primaryKey);
        self::assertTrue($meta->reliableRowIdentity);
        $page = $this->catalog->tablePage($author, 3, 0);
        self::assertSame(['seq'], $page->orderBy);
        self::assertTrue($page->hasMore);
        self::assertCount(3, $page->result->rows);
        $count = $this->catalog->readOnlyQuery('SELECT COUNT(*) FROM ' . $this->quote('user'), []);
        self::assertSame(5000, (int) $count->rows[0][0]);
        $this->expectExceptionMessage('QUERY_READ_ONLY');
        $this->catalog->readOnlyQuery('UPDATE ' . $this->quote('user') . ' SET name = name WHERE seq = 1', []);
    }

    public function testRowMutation(): void
    {
        $account = $this->quote('composite_account');
        $countSql = "SELECT COUNT(*) FROM {$account} WHERE tenant_id = " . self::TENANT;
        $tenantRows = fn (): int => (int) $this->catalog->readOnlyQuery($countSql, [])->rows[0][0];
        self::assertSame(0, $tenantRows());
        $table = ['namespace' => $this->catalog->currentNamespace(), 'name' => 'composite_account'];
        $meta = $this->catalog->describeTable($table);
        $inserted = $this->catalog->insertRow(
            $meta,
            ['tenant_id' => self::TENANT, 'account_id' => 1, 'name' => 'catalog']
        );
        self::assertCount(1, $inserted->rows);
        $find = function (string $want) use ($table): object {
            $page = $this->catalog->tablePage($table, 1000, 0);
            self::assertFalse($page->hasMore);
            $found = [];
            foreach ($page->result->rows as $i => $row) {
                if ($row[$page->columnIndex('tenant_id')] === self::TENANT) {
                    $found[] = $i;
                }
            }
            self::assertCount(1, $found);
            self::assertSame($want, $page->result->rows[$found[0]][$page->columnIndex('name')]);
            return $this->catalog->rowSnapshotFromPage($page, $found[0]);
        };
        $updated = $this->catalog->updateRow($find('catalog'), ['name' => 'catalog-updated']);
        self::assertCount(1, $updated->rows);
        self::assertSame(1, $this->catalog->deleteRow($find('catalog-updated')));
        self::assertSame(0, $tenantRows());
    }

    /**
     * The grid cells of one row per dialect (docs/spec/interfaces.md, "Rust native grid query specification"): float
     * cells hold their IEEE-754 bits in hexadecimal, UNSIGNED integers are exact decimal digits, and date, time and
     * datetime cells hold dbspec text. Each refused value fails with CATALOG_VALUE.
     */
    public function testGridCells(): void
    {
        [$sql, $expected, $refused] = match ($this->driver) {
            'mysql' => [
                "SELECT CAST(1.5 AS FLOAT) AS f, CAST(1.5 AS DOUBLE) AS d, "
                . "CAST(1.50 AS DECIMAL(10,2)) AS dv, CAST(NULL AS DATE) AS n, "
                . "CAST('2024-02-29' AS DATE) AS dt, CAST('12:34:56.5' AS TIME(6)) AS tm, "
                . "CAST('2024-02-29 01:02:03.5' AS DATETIME(6)) AS dtm",
                [
                    new CatalogGridCell('float32', '3fc00000'),
                    new CatalogGridCell('float64', '3ff8000000000000'),
                    new CatalogGridCell('decimal', '1.50'),
                    new CatalogGridCell('null'),
                    new CatalogGridCell('date', '2024-02-29'),
                    new CatalogGridCell('time', '12:34:56.500000'),
                    new CatalogGridCell('datetime', '2024-02-29 01:02:03.500000'),
                ],
                [
                    "SELECT CAST('-01:00:00' AS TIME(6)) AS t",
                    // PDO reports no UNSIGNED flag for an integer expression, so its signedness is not known: refused.
                    "SELECT CAST(-7 AS SIGNED) AS i",
                    "SELECT CAST(18446744073709551615 AS UNSIGNED) AS u",
                    "SELECT CAST('ab' AS BINARY) AS b",
                ],
            ],
            'postgres' => [
                "SELECT 1.5::real AS f, 1.5::double precision AS d, 'NaN'::double precision AS nan, 'NaN'::real AS "
                . "nanf, "
                . "9223372036854775807::bigint AS i, 2.50::numeric(10,2) AS dec, '\\x6162'::bytea AS b, NULL::date "
                . "AS n, "
                . "'2024-02-29'::date AS dt, '12:34:56.5'::time AS tm, '2024-02-29 01:02:03.5'::timestamp AS dtm",
                [
                    new CatalogGridCell('float32', '3fc00000'),
                    new CatalogGridCell('float64', '3ff8000000000000'),
                    new CatalogGridCell('float64', '7ff8000000000000'),
                    new CatalogGridCell('float32', '7fc00000'),
                    new CatalogGridCell('integer', 9223372036854775807),
                    new CatalogGridCell('decimal', '2.50'),
                    new CatalogGridCell('binary', 'ab'),
                    new CatalogGridCell('null'),
                    new CatalogGridCell('date', '2024-02-29'),
                    new CatalogGridCell('time', '12:34:56.500000'),
                    new CatalogGridCell('datetime', '2024-02-29 01:02:03.500000'),
                ],
                [
                    "SELECT '2024-01-01 00:00:00+00'::timestamptz AS t",
                    "SELECT '00:00:00+00'::timetz AS t",
                    "SELECT '24:00:00'::time AS t",
                    "SELECT 'infinity'::date AS t",
                ],
            ],
            default => [
                "SELECT 1.5 AS d, 7 AS i, 'x' AS t, X'6162' AS b, NULL AS n",
                [
                    new CatalogGridCell('float64', '3ff8000000000000'),
                    new CatalogGridCell('integer', 7),
                    new CatalogGridCell('text', 'x'),
                    new CatalogGridCell('binary', 'ab'),
                    new CatalogGridCell('null'),
                ],
                [],
            ],
        };
        $result = $this->catalog->readOnlyGridQuery($sql, []);
        self::assertCount(1, $result->rows);
        self::assertEquals($expected, $result->rows[0]);
        // A table column takes its type from its definition: the integer of user.seq is an integer cell on every
        // database.
        $seq = $this->catalog->readOnlyGridQuery(
            'SELECT seq FROM ' . $this->quote('user') . ' ORDER BY seq LIMIT 1',
            []
        );
        self::assertSame('integer', $seq->rows[0][0]->kind);
        foreach ($refused as $query) {
            try {
                $this->catalog->readOnlyGridQuery($query, []);
                self::fail("a grid value of $query was not refused");
            } catch (OrmException $e) {
                self::assertStringContainsString('CATALOG_VALUE', $e->getMessage());
            }
        }
    }
}
