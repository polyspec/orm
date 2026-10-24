<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogGridCell;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

/** Shared PHP host cases for both the library and native extension Catalog clients. */
trait CatalogConnectionCoverageCases
{
    abstract protected function assertCatalogImplementation(): void;

    private const TENANT = 990005;

    private string $driver = '';
    private ?Catalog $catalog = null;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertCatalogImplementation();
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

    public function testCatalogRead(): void
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
        $snapshot = $this->catalog->rowSnapshotFromPage($page, 0);
        self::assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $snapshot->revision());
        $this->assertGridCells();
        try {
            $this->catalog->readOnlyQuery('UPDATE ' . $this->quote('user') . ' SET name = name WHERE seq = 1', []);
            self::fail('a read-only catalog query accepted an update');
        } catch (OrmException $e) {
            self::assertSame(Code::QUERY_READ_ONLY, $e->code_);
        }
        $this->catalog->close();
        $this->catalog->close();
        self::assertSame($snapshot->revision(), $this->catalog->rowSnapshotFromPage($page, 0)->revision());
        try {
            $this->catalog->readOnlyQuery('SELECT 1', []);
            self::fail('a database operation after close succeeded');
        } catch (OrmException $e) {
            self::assertSame(Code::CATALOG_CLOSED, $e->code_);
        }
    }

    public function testCatalogRowMutation(): void
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
        $this->assertIdentityRequiredError();
        $this->assertAutomaticGeneratedKey();
        $this->assertLiteralDefaultKey();
        $this->assertExpressionDefaultKey();
        $this->assertFailedCommitLeavesNoRow();
    }

    private function assertIdentityRequiredError(): void
    {
        $name = 'catalog_identity_required_' . bin2hex(random_bytes(6));
        $namespace = $this->catalog->currentNamespace();
        $qualified = $this->quote($namespace) . '.' . $this->quote($name);
        $engine = $this->driver === 'mysql' ? ' ENGINE=InnoDB' : '';
        $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
        $pdo = $setup->pdo();
        try {
            $pdo->exec("CREATE TABLE {$qualified} (id BIGINT NOT NULL PRIMARY KEY, payload TEXT NOT NULL){$engine}");
            $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
            try {
                $this->catalog->insertRow($metadata, ['payload' => 'missing-key']);
                self::fail('an omitted primary key without a generator was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::ROW_INSERT_IDENTITY_REQUIRED, $error->code_);
            }
        } finally {
            try {
                $pdo->exec("DROP TABLE IF EXISTS {$qualified}");
            } finally {
                $setup->close();
            }
        }
    }

    private function assertAutomaticGeneratedKey(): void
    {
        $name = 'catalog_generated_auto_' . bin2hex(random_bytes(6));
        $namespace = $this->catalog->currentNamespace();
        $qualified = $this->quote($namespace) . '.' . $this->quote($name);
        $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
        $pdo = $setup->pdo();
        $id = match ($this->driver) {
            'sqlite' => 'INTEGER PRIMARY KEY AUTOINCREMENT',
            'mysql' => 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY',
            'postgres' => 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
        };
        $engine = $this->driver === 'mysql' ? ' ENGINE=InnoDB' : '';
        try {
            $pdo->exec("CREATE TABLE {$qualified} (id {$id}, payload TEXT NOT NULL){$engine}");
            $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
            self::assertSame(['id'], $metadata->primaryKey);
            self::assertFalse($metadata->columns[0]->nullable);
            self::assertFalse($metadata->columns[0]->generated);
            self::assertTrue($metadata->columns[0]->automaticKey);
            self::assertNull($metadata->columns[0]->defaultExpression);
            self::assertFalse($metadata->columns[0]->expressionDefault);

            $inserted = $this->catalog->insertRow($metadata, ['payload' => 'generated']);
            self::assertSame(['id', 'payload'], $inserted->columns);
            self::assertSame([[1, 'generated']], $inserted->rows);
            self::assertSame(
                $inserted->rows,
                $this->catalog->tablePage(['namespace' => $namespace, 'name' => $name], 2, 0)->result->rows
            );
        } finally {
            try {
                $pdo->exec("DROP TABLE IF EXISTS {$qualified}");
            } finally {
                $setup->close();
            }
        }
    }

    private function assertLiteralDefaultKey(): void
    {
        $name = 'catalog_generated_literal_' . bin2hex(random_bytes(6));
        $namespace = $this->catalog->currentNamespace();
        $qualified = $this->quote($namespace) . '.' . $this->quote($name);
        $engine = $this->driver === 'mysql' ? ' ENGINE=InnoDB' : '';
        $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
        $pdo = $setup->pdo();
        try {
            $pdo->exec(
                "CREATE TABLE {$qualified} (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', "
                . "n BIGINT NOT NULL, PRIMARY KEY (tenant, seq)){$engine}"
            );
            $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
            self::assertSame(['tenant', 'seq'], $metadata->primaryKey);
            self::assertNotNull($metadata->columns[1]->defaultExpression);
            self::assertFalse($metadata->columns[1]->automaticKey);
            $inserted = $this->catalog->insertRow($metadata, ['tenant' => 2, 'n' => 50]);
            self::assertSame(['tenant', 'seq', 'n'], $inserted->columns);
            self::assertSame([[2, 'generated', 50]], $inserted->rows);
            self::assertSame(
                $inserted->rows,
                $this->catalog->tablePage(['namespace' => $namespace, 'name' => $name], 2, 0)->result->rows
            );
        } finally {
            try {
                $pdo->exec("DROP TABLE IF EXISTS {$qualified}");
            } finally {
                $setup->close();
            }
        }
    }

    private function assertExpressionDefaultKey(): void
    {
        $name = 'catalog_generated_expression_' . bin2hex(random_bytes(6));
        $namespace = $this->catalog->currentNamespace();
        $qualified = $this->quote($namespace) . '.' . $this->quote($name);
        $expression = match ($this->driver) {
            'sqlite' => 'lower(hex(randomblob(16)))',
            'mysql' => 'UUID()',
            'postgres' => 'gen_random_uuid()::text',
        };
        $keyType = $this->driver === 'sqlite' ? 'TEXT' : 'VARCHAR(36)';
        $engine = $this->driver === 'mysql' ? ' ENGINE=InnoDB' : '';
        $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
        $pdo = $setup->pdo();
        try {
            $pdo->exec(
                "CREATE TABLE {$qualified} (seq {$keyType} NOT NULL DEFAULT ({$expression}) PRIMARY KEY, "
                . "n BIGINT NOT NULL UNIQUE, label VARCHAR(20) NULL){$engine}"
            );
            $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
            self::assertSame(['seq'], $metadata->primaryKey);
            self::assertTrue($metadata->columns[0]->expressionDefault);
            $inserted = $this->catalog->insertRow($metadata, ['n' => 1, 'label' => null]);
            $rows = $inserted->rows;
            self::assertCount(1, $rows);
            $pattern = $this->driver === 'sqlite'
                ? '/^[0-9a-f]{32}$/D'
                : '/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/Di';
            self::assertMatchesRegularExpression($pattern, $rows[0][0]);
            self::assertSame([1, null], array_slice($rows[0], 1));
            self::assertSame(
                $rows,
                $this->catalog->tablePage(['namespace' => $namespace, 'name' => $name], 2, 0)->result->rows
            );
        } finally {
            try {
                $pdo->exec("DROP TABLE IF EXISTS {$qualified}");
            } finally {
                $setup->close();
            }
        }
    }

    private function assertFailedCommitLeavesNoRow(): void
    {
        $name = 'catalog_commit_' . bin2hex(random_bytes(6));
        $namespace = $this->catalog->currentNamespace();
        $qualified = $this->quote($namespace) . '.' . $this->quote($name);
        $parent = $this->quote($namespace) . '.' . $this->quote('user');
        $constraint = $this->quote('fk_' . $name);
        $deferred = $this->driver === 'mysql' ? '' : ' DEFERRABLE INITIALLY DEFERRED';
        $create = "CREATE TABLE {$qualified} (id BIGINT PRIMARY KEY, parent_id BIGINT NOT NULL, "
            . "CONSTRAINT {$constraint} FOREIGN KEY(parent_id) REFERENCES {$parent}(seq){$deferred})";
        if ($this->driver === 'mysql') {
            $create .= ' ENGINE=InnoDB';
        }
        $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
        $pdo = $setup->pdo();
        try {
            $pdo->exec($create);
            $table = ['namespace' => $namespace, 'name' => $name];
            $metadata = $this->catalog->describeTable($table);
            try {
                $this->catalog->insertRow($metadata, ['id' => 1, 'parent_id' => -990005]);
                self::fail('a row with a missing deferred parent committed');
            } catch (OrmException $e) {
                $expected = $this->driver === 'mysql' ? Code::FOREIGN_KEY : Code::ROW_COMMIT_REJECTED;
                self::assertSame($expected, $e->code_);
            }
            $rows = $this->catalog->readOnlyQuery("SELECT COUNT(*) FROM {$qualified} WHERE id = ?", [1]);
            self::assertSame(0, (int) $rows->rows[0][0]);
        } finally {
            try {
                $pdo->exec("DROP TABLE IF EXISTS {$qualified}");
            } finally {
                $setup->close();
            }
        }
    }

    /**
     * The grid cells of one row per dialect (docs/spec/interfaces.md, "Rust native grid query specification"): float
     * cells hold their IEEE-754 bits in hexadecimal, UNSIGNED integers are exact decimal digits, and date, time and
     * datetime cells hold dbspec text. The binding is the PHP grid cell binding of SCH-6a (docs/spec/schema.md). Each
     * refused value fails with CATALOG_VALUE. The PHP client and extension follow the same MySQL field flags for
     * unsigned integers and binary values.
     */
    private function assertGridCells(): void
    {
        [$sql, $expected, $refused] = match ($this->driver) {
            'mysql' => [
                "SELECT CAST(1.5 AS FLOAT) AS f, CAST(1.5 AS DOUBLE) AS d, "
                . "CAST(18446744073709551615 AS UNSIGNED) AS u, CAST(-7 AS SIGNED) AS i, "
                . "CAST(1.50 AS DECIMAL(10,2)) AS dv, CAST('ab' AS BINARY) AS b, CAST(NULL AS DATE) AS n, "
                . "CAST('2024-02-29' AS DATE) AS dt, CAST('12:34:56.5' AS TIME(6)) AS tm, "
                . "CAST('2024-02-29 01:02:03.5' AS DATETIME(6)) AS dtm",
                [
                    new CatalogGridCell('float32', '3fc00000'),
                    new CatalogGridCell('float64', '3ff8000000000000'),
                    new CatalogGridCell('unsigned', '18446744073709551615'),
                    new CatalogGridCell('integer', -7),
                    new CatalogGridCell('decimal', '1.50'),
                    new CatalogGridCell('binary', 'ab'),
                    new CatalogGridCell('null'),
                    new CatalogGridCell('date', '2024-02-29'),
                    new CatalogGridCell('time', '12:34:56.500000'),
                    new CatalogGridCell('datetime', '2024-02-29 01:02:03.500000'),
                ],
                [
                    "SELECT CAST('-01:00:00' AS TIME(6)) AS t",
                ],
            ],
            'postgres' => [
                "SELECT 1.5::real AS f, 1.5::double precision AS d, 'NaN'::double precision AS nan, "
                . "'NaN'::real AS nanf, "
                . "9223372036854775807::bigint AS i, 2.50::numeric(10,2) AS dec, '\\x6162'::bytea AS b, "
                . "NULL::date AS n, "
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
