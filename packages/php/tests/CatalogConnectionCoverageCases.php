<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

/**
 * Shared PHP host cases for both the library and native extension Catalog clients. The behaviour that the recipe
 * contracts/fixtures/catalog_connection/catalog_connection.json asserts on every database is not kept here (FCV-2);
 * the cases below keep only what no recipe case asserts, each named by a GAP in the mapping.
 */
trait CatalogConnectionCoverageCases
{
    abstract protected function assertCatalogImplementation(): void;

    abstract protected function assertModelImplementation(): void;

    private const TENANT = 990005;

    private string $driver = '';
    private ?Catalog $catalog = null;

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertCatalogImplementation();
        $this->assertModelImplementation();
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

    private function qualifiedReference(string $namespace, string $name): string
    {
        return $this->driver === 'sqlite'
            ? $this->quote($name)
            : $this->quote($namespace) . '.' . $this->quote($name);
    }

    // Requirements: SCH-3, SCH-5, SCH-6, SCH-6a, INT-101, INT-103, INT-104.
    // Requirements: INT-112, INT-113, INT-114, INT-115, INT-121, INT-136, INT-117.
    public function testCatalogRead(): void
    {
        $author = ['namespace' => $this->catalog->currentNamespace(), 'name' => 'author'];
        $page = $this->catalog->tablePage($author, 1, 0);
        $snapshot = $this->catalog->rowSnapshotFromPage($page, 0);
        self::assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $snapshot->revision());
        $this->assertMysqlTemporalPrecisionLimit();
        $this->assertGridRefusalsAndKeyKind();
        $this->catalog->close();
        $this->catalog->close();
        self::assertSame($snapshot->revision(), $this->catalog->rowSnapshotFromPage($page, 0)->revision());
    }


    /**
     * MySQL refuses a temporal column of precision 7. No recipe case creates a column with a refused definition, and
     * the recipe's sql.exec step has no expect that a server refusal can meet (GAP).
     */
    private function assertMysqlTemporalPrecisionLimit(): void
    {
        if ($this->driver !== 'mysql') {
            return;
        }
        $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
        $name = 'catalog_temporal_precision_invalid_' . bin2hex(random_bytes(6));
        try {
            try {
                $setup->pdo()->exec("CREATE TABLE {$this->quote($name)} (id BIGINT PRIMARY KEY, t TIME(7))");
                self::fail('MySQL accepted temporal precision 7');
            } catch (\PDOException $error) {
                self::assertStringContainsString('precision', strtolower($error->getMessage()));
            }
        } finally {
            $setup->pdo()->exec('DROP TABLE IF EXISTS ' . $this->quote($name));
            $setup->close();
        }
    }

    /**
     * Grid refusals that the recipe does not express: the recipe names other values, or the same values with another
     * error code (MySQL TIME(6) and PostgreSQL 24:00:00 and infinity::date are CATALOG_VALUE here, while the recipe
     * says GRID_TEMPORAL_VALUE for other literals), plus the PostgreSQL timetz, which the recipe does not name. The
     * integer kind of a table column in a grid read is not asserted by any recipe case.
     */
    private function assertGridRefusalsAndKeyKind(): void
    {
        $refused = match ($this->driver) {
            'mysql' => ["SELECT CAST('-01:00:00' AS TIME(6)) AS t"],
            'postgres' => [
                "SELECT '00:00:00+00'::timetz AS t",
                "SELECT '24:00:00'::time AS t",
                "SELECT 'infinity'::date AS t",
            ],
            default => [],
        };
        foreach ($refused as $query) {
            try {
                $this->catalog->readOnlyGridQuery($query, []);
                self::fail("a grid value of $query was not refused");
            } catch (OrmException $e) {
                self::assertStringContainsString('CATALOG_VALUE', $e->getMessage());
            }
        }
        $seq = $this->catalog->readOnlyGridQuery(
            'SELECT seq FROM ' . $this->quote('user') . ' ORDER BY seq LIMIT 1',
            []
        );
        self::assertSame('integer', $seq->rows[0][0]->kind);
    }

    // Requirements: DBS-113, INT-34, INT-106, INT-108, INT-109, INT-110, INT-111.
    public function testCatalogRowMutation(): void
    {
        $this->assertRefusedUpdateWritesNothing();
        $this->assertIdentityRequiredError();
        $this->assertAutomaticGeneratedKey();
        $this->assertLiteralDefaultKey();
        $this->assertExpressionDefaultKey();
        $this->assertFailedCommitLeavesNoRow();
    }


    /**
     * GAP: no recipe case reads the row after a refused update, so this checks that the refused write changed nothing.
     * The refusal is asserted by row_mutation step 7; here it is the write that the read follows.
     */
    private function assertRefusedUpdateWritesNothing(): void
    {
        $table = ['namespace' => $this->catalog->currentNamespace(), 'name' => 'composite_account'];
        $metadata = $this->catalog->describeTable($table);
        $this->catalog->insertRow($metadata, ['tenant_id' => self::TENANT, 'account_id' => 1, 'name' => 'catalog']);
        $locate = function () use ($table): object {
            $page = $this->catalog->tablePage($table, 1000, 0);
            foreach ($page->result->rows as $index => $row) {
                if ($row[$page->columnIndex('tenant_id')] === self::TENANT) {
                    return $this->catalog->rowSnapshotFromPage($page, $index);
                }
            }
            throw new \LogicException('the test row is missing');
        };
        $original = $locate();
        $revision = $original->revision();
        $refused = false;
        try {
            $this->catalog->updateRow($original, ['absent' => 'value']);
        } catch (OrmException $error) {
            $refused = $error->code_ === Code::ROW_UPDATE_INVALID;
        }
        self::assertTrue($refused, 'the refused update must fail with ROW_UPDATE_INVALID');
        self::assertSame($revision, $locate()->revision());
        $this->catalog->deleteRow($locate());
    }

    private function assertIdentityRequiredError(): void
    {
        $this->withTemporaryCatalogTable(
            'catalog_identity_required_',
            "id BIGINT NOT NULL PRIMARY KEY, payload TEXT NOT NULL",
            function (string $namespace, string $name): void {
                $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
                try {
                    $this->catalog->insertRow($metadata, ['payload' => 'missing-key']);
                    self::fail('an omitted primary key without a generator was accepted');
                } catch (OrmException $error) {
                    self::assertSame(Code::ROW_INSERT_IDENTITY_REQUIRED, $error->code_);
                }
            }
        );
    }

    private function assertAutomaticGeneratedKey(): void
    {
        $id = match ($this->driver) {
            'sqlite' => 'INTEGER PRIMARY KEY AUTOINCREMENT',
            'mysql' => 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY',
            'postgres' => 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY',
        };
        $this->withTemporaryCatalogTable(
            'catalog_generated_auto_',
            "id {$id}, payload TEXT NOT NULL",
            function (string $namespace, string $name): void {
                $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
                self::assertSame(['id'], $metadata->primaryKey);
                self::assertFalse($metadata->columns[0]->nullable);
                // A PostgreSQL GENERATED ALWAYS identity cannot be assigned, so its descriptor marks it generated.
                self::assertSame($this->driver === 'postgres', $metadata->columns[0]->generated);
                self::assertTrue($metadata->columns[0]->automaticKey);
                self::assertNull($metadata->columns[0]->defaultExpression);
                self::assertFalse($metadata->columns[0]->expressionDefault);

                $inserted = $this->catalog->insertRow($metadata, ['payload' => 'generated']);
                self::assertSame(['id', 'payload'], $inserted->columns);
                self::assertSame([[1, 'generated']], $inserted->rows);
                $this->assertCatalogPageRows($name, $inserted->rows);
            }
        );
    }

    private function assertLiteralDefaultKey(): void
    {
        $this->withTemporaryCatalogTable(
            'catalog_generated_literal_',
            "tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', "
                . "n BIGINT NOT NULL, PRIMARY KEY (tenant, seq)",
            function (string $namespace, string $name): void {
                $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
                self::assertSame(['tenant', 'seq'], $metadata->primaryKey);
                self::assertNotNull($metadata->columns[1]->defaultExpression);
                self::assertFalse($metadata->columns[1]->automaticKey);
                $inserted = $this->catalog->insertRow($metadata, ['tenant' => 2, 'n' => 50]);
                self::assertSame(['tenant', 'seq', 'n'], $inserted->columns);
                self::assertSame([[2, 'generated', 50]], $inserted->rows);
                $this->assertCatalogPageRows($name, $inserted->rows);
            }
        );
    }

    private function assertExpressionDefaultKey(): void
    {
        $expression = match ($this->driver) {
            'sqlite' => 'lower(hex(randomblob(16)))',
            'mysql' => 'UUID()',
            'postgres' => 'gen_random_uuid()::text',
        };
        $keyType = $this->driver === 'sqlite' ? 'TEXT' : 'VARCHAR(36)';
        $this->withTemporaryCatalogTable(
            'catalog_generated_expression_',
            "seq {$keyType} NOT NULL DEFAULT ({$expression}) PRIMARY KEY, "
                . "n BIGINT NOT NULL UNIQUE, label VARCHAR(20) NULL",
            function (string $namespace, string $name): void {
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
                $this->assertCatalogPageRows($name, $rows);
            }
        );
    }

    /** Run a generated-key case against a temporary table and always drop its table and setup connection. */
    private function withTemporaryCatalogTable(string $prefix, string $definition, callable $assert): void
    {
        $name = $prefix . bin2hex(random_bytes(6));
        $namespace = $this->catalog->currentNamespace();
        $qualified = $this->quote($namespace) . '.' . $this->quote($name);
        $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
        $pdo = $setup->pdo();
        try {
            // A MySQL table is InnoDB, the only engine the catalog writes to.
            $options = $this->driver === 'mysql' ? ' ENGINE=InnoDB' : '';
            $pdo->exec("CREATE TABLE {$qualified} ({$definition}){$options}");
            $assert($namespace, $name);
        } finally {
            try {
                $pdo->exec("DROP TABLE IF EXISTS {$qualified}");
            } finally {
                $setup->close();
            }
        }
    }

    /** @param list<list<mixed>> $rows */
    private function assertCatalogPageRows(string $name, array $rows): void
    {
        self::assertSame(
            $rows,
            $this->catalog->tablePage(
                ['namespace' => $this->catalog->currentNamespace(), 'name' => $name],
                2,
                0
            )->result->rows
        );
    }

    private function assertFailedCommitLeavesNoRow(): void
    {
        $name = 'catalog_commit_' . bin2hex(random_bytes(6));
        $namespace = $this->catalog->currentNamespace();
        $qualified = $this->quote($namespace) . '.' . $this->quote($name);
        $parent = $this->qualifiedReference($namespace, 'user');
        $constraint = $this->quote('fk_' . $name);
        $deferred = $this->driver === 'mysql' ? '' : ' DEFERRABLE INITIALLY DEFERRED';
        $create = "CREATE TABLE {$qualified} (id BIGINT NOT NULL PRIMARY KEY, parent_id BIGINT NOT NULL, "
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

    protected function assertPlainQueryBounds(): void
    {
        $catalog = $this->catalog ?? throw new \LogicException('catalog connection is not set');
        $rows = "SELECT 'alpha' AS value UNION ALL SELECT 'beta' AS value";
        try {
            $catalog->readOnlyQuery($rows, [], 1, 128);
            self::fail('a plain query over its row limit returned partial success');
        } catch (OrmException $e) {
            self::assertSame('CATALOG_LIMIT: result has more than 1 rows', $e->getMessage());
        }

        $bytes = "SELECT 'abc' AS value";
        try {
            $catalog->readOnlyQuery($bytes, [], 2, 2);
            self::fail('a plain query over its byte limit returned partial success');
        } catch (OrmException $e) {
            self::assertSame('CATALOG_LIMIT: result has more than 2 bytes of values', $e->getMessage());
        }
    }

    // Requirements: COD-31.
    public function testOrderedJsonEmptyTextIsRefused(): void
    {
        try {
            Codec::decode(['ordered_json'], '');
            self::fail('empty text with ordered_json was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
        }
    }
}
