<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogGridCell;
use Polyspec\Orm\CatalogTablePage;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

/** Shared PHP host cases for both the library and native extension Catalog clients. */
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
        $this->assertCatalogConnectionInputs();
        $namespace = $this->catalog->currentNamespace();
        $author = ['namespace' => $namespace, 'name' => 'author'];
        $meta = $this->catalog->describeTable($author);
        self::assertSame(['seq'], $meta->primaryKey);
        self::assertTrue($meta->reliableRowIdentity);
        $metadataColumns = 'a BIGINT NOT NULL, b BIGINT NOT NULL, note VARCHAR(50), '
            . 'g BIGINT GENERATED ALWAYS AS (a+1) STORED, PRIMARY KEY (b,a)';
        $this->withTemporaryCatalogTable(
            'catalog_metadata_',
            $metadataColumns,
            function (string $namespace, string $name): void {
                $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
                $columns = $metadata->columns;
                $nativeTypes = array_map(static fn ($column): string => $column->nativeType, $columns);
                $wantNativeTypes = match ($this->driver) {
                    'mysql' => ['bigint', 'bigint', 'varchar(50)', 'bigint'],
                    'postgres' => ['bigint', 'bigint', 'character varying(50)', 'bigint'],
                    'sqlite' => ['BIGINT', 'BIGINT', 'VARCHAR(50)', 'BIGINT'],
                };
                self::assertSame(
                    ['a', 'b', 'note', 'g'],
                    array_map(static fn ($column): string => $column->name, $columns),
                );
                self::assertSame($wantNativeTypes, $nativeTypes);
                self::assertSame(['b', 'a'], $metadata->primaryKey);
                self::assertTrue($columns[2]->nullable);
                self::assertTrue($columns[3]->generated);
                self::assertTrue($metadata->reliableRowIdentity);
            },
        );
        $page = $this->catalog->tablePage($author, 3, 0);
        self::assertSame(['seq'], $page->orderBy);
        self::assertTrue($page->hasMore);
        self::assertCount(3, $page->result->rows);
        self::assertSame(
            array_map(static fn ($column): string => $column->name, $meta->columns),
            $page->result->columns,
        );
        foreach ([[0, 0], [1001, 0], [1, 1000001]] as [$limit, $offset]) {
            try {
                $this->catalog->tablePage($author, $limit, $offset);
                self::fail("table page accepted limit {$limit} offset {$offset}");
            } catch (OrmException $error) {
                self::assertSame(Code::TABLE_PAGE_INVALID, $error->code_);
            }
        }
        $count = $this->catalog->readOnlyQuery('SELECT COUNT(*) FROM ' . $this->quote('user'), []);
        self::assertSame(5000, (int) $count->rows[0][0]);
        if ($this->driver === 'mysql') {
            $name = 'catalog_readonly_' . bin2hex(random_bytes(6));
            $function = $name . '_fn';
            $setup = Orm::connect((string) getenv('ORM_FEATURE_DSN'), new Config());
            try {
                $setup->pdo()->exec('CREATE TABLE ' . $this->quote($name) . ' (n INTEGER NOT NULL)');
                $setup->pdo()->exec('INSERT INTO ' . $this->quote($name) . ' VALUES (7)');
                $setup->pdo()->exec(
                    'CREATE FUNCTION ' . $this->quote($function)
                    . '() RETURNS INTEGER DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE '
                    . $this->quote($name) . ' SET n=n+1; RETURN 1; END',
                );
                try {
                    $this->catalog->readOnlyGridQuery('SELECT ' . $this->quote($function) . '()', []);
                    self::fail('a database-enforced read-only scope allowed a function to write');
                } catch (OrmException $error) {
                    self::assertSame(Code::QUERY_READ_ONLY, $error->code_);
                }
            } finally {
                $setup->pdo()->exec('DROP FUNCTION IF EXISTS ' . $this->quote($function));
                $setup->pdo()->exec('DROP TABLE IF EXISTS ' . $this->quote($name));
                $setup->close();
            }
        } else {
            $readOnlySQL = $this->driver === 'postgres'
                ? "SELECT current_setting('transaction_read_only')"
                : 'SELECT query_only FROM pragma_query_only';
            $readOnlyState = $this->catalog->readOnlyQuery($readOnlySQL, []);
            self::assertSame(
                $this->driver === 'postgres' ? 'on' : 1,
                $readOnlyState->rows[0][0],
            );
        }
        if ($this->driver === 'mysql') {
            $classification = $this->catalog->readOnlyQuery(
                "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'information_schema' "
                . "AND TABLE_NAME = 'TABLES'",
                []
            );
            self::assertSame('SYSTEM VIEW', $classification->rows[0][0]);
            $systemView = $this->catalog->describeTable(['namespace' => 'information_schema', 'name' => 'TABLES']);
            self::assertSame('view', $systemView->kind);
            self::assertNotEmpty($systemView->columns);
            self::assertSame([], $systemView->primaryKey);
            self::assertFalse($systemView->reliableRowIdentity);
        }
        foreach (
            [
                [['maxRows' => 1, 'maxBytes' => 1024], "SELECT 'abc' AS value UNION ALL SELECT 'def'"],
                [['maxRows' => 2, 'maxBytes' => 2], "SELECT 'abc' AS value"],
            ] as [$limits, $sql]
        ) {
            try {
                $this->catalog->readOnlyGridQuery($sql, [], $limits['maxRows'], $limits['maxBytes']);
                self::fail('a grid query over its result budget returned partial success');
            } catch (OrmException $e) {
                self::assertSame(Code::CATALOG_LIMIT, $e->code_);
            }
        }
        $snapshot = $this->catalog->rowSnapshotFromPage($page, 0);
        self::assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $snapshot->revision());
        $this->assertTemporalDefaultPrecision();
        $this->assertGridCells();
        try {
            $this->catalog->readOnlyQuery('UPDATE ' . $this->quote('user') . ' SET name = name WHERE seq = 1', []);
            self::fail('a read-only catalog query accepted an update');
        } catch (OrmException $e) {
            self::assertSame(Code::QUERY_READ_ONLY, $e->code_);
        }
        foreach (
            [
                "SELECT ';' AS value /* ; */",
                'WITH values_cte AS (SELECT 1 AS value) SELECT value FROM values_cte',
            ] as $sql
        ) {
            $this->catalog->readOnlyGridQuery($sql);
        }
        $readOnlyRefusals = [
            'COMMIT',
            'CALL missing_catalog_procedure()',
            'SELECT 1 INTO catalog_forbidden',
            'SELECT 1 FOR UPDATE',
            'SELECT 1; SELECT 2',
            'WITH changed AS (UPDATE user SET name=name WHERE seq=1 RETURNING seq) SELECT seq FROM changed',
        ];
        if ($this->driver === 'postgres') {
            $readOnlyRefusals[] = 'SELECT ' . rtrim(str_repeat('1 UNION ALL ', 200), ' UNION ALL ');
            $readOnlyRefusals[] = 'SELECT ' . rtrim(str_repeat('1+', 200), '+');
        }
        foreach ($readOnlyRefusals as $sql) {
            try {
                $this->catalog->readOnlyGridQuery($sql);
                self::fail("read-only grid query accepted {$sql}");
            } catch (OrmException $error) {
                self::assertSame(Code::QUERY_READ_ONLY, $error->code_, "read-only grid refusal: {$sql}");
            }
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

    private function assertCatalogConnectionInputs(): void
    {
        try {
            $unexpected = Catalog::connect('unsupported://host/database');
            $unexpected->close();
            self::fail('catalog connection accepted an unsupported DSN');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
        }

        $directory = sys_get_temp_dir() . '/orm-catalog-missing-' . bin2hex(random_bytes(8));
        self::assertTrue(mkdir($directory, 0700), 'create the owned SQLite fixture directory');
        $path = $directory . '/missing.sqlite';
        try {
            try {
                $unexpected = Catalog::connect('sqlite://' . $path);
                $unexpected->close();
                self::fail('catalog connection accepted a missing SQLite database');
            } catch (OrmException $error) {
                self::assertSame(Code::CONFIG, $error->code_);
            }
            self::assertFileDoesNotExist($path, 'catalog connection must not create a missing SQLite database');
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
            rmdir($directory);
        }
    }

    /** Requirements: INT-101, INT-117. */
    private function assertTemporalDefaultPrecision(): void
    {
        $columns = match ($this->driver) {
            'sqlite' => implode(' ', [
                'id INTEGER NOT NULL PRIMARY KEY,',
                't0 TIME NOT NULL CHECK (length("t0") = 8 AND',
                '"t0" IS time("t0") AND "t0" < \'24:00:00\'),',
                'dt0 DATETIME NOT NULL CHECK (length("dt0") = 19 AND',
                '"dt0" IS datetime("dt0") AND substr("dt0", 12, 2) < \'24\'),',
                't3 TIME NOT NULL CHECK (length("t3") = 12 AND',
                'substr("t3", 1, 8) IS time(substr("t3", 1, 8)) AND "t3" < \'24:00:00\'',
                'AND substr("t3", 9, 1) = \'.\' AND substr("t3", 10) GLOB \'[0-9][0-9][0-9]\'),',
                'dt3 DATETIME NOT NULL CHECK (length("dt3") = 23 AND',
                'substr("dt3", 1, 19) IS datetime(substr("dt3", 1, 19))',
                'AND substr("dt3", 12, 2) < \'24\' AND substr("dt3", 20, 1) = \'.\'',
                'AND substr("dt3", 21) GLOB \'[0-9][0-9][0-9]\')',
            ]),
            'mysql' => 'id BIGINT NOT NULL PRIMARY KEY, t0 TIME NULL, dt0 DATETIME NULL, '
                . 't3 TIME(3) NULL, dt3 DATETIME(3) NULL',
            default => 'id BIGINT NOT NULL PRIMARY KEY, t0 TIME WITHOUT TIME ZONE NULL, '
                . 'dt0 TIMESTAMP WITHOUT TIME ZONE NULL, t3 TIME(3) WITHOUT TIME ZONE NULL, '
                . 'dt3 TIMESTAMP(3) WITHOUT TIME ZONE NULL',
        };
        $assert = function (string $namespace, string $name): void {
            $metadata = $this->catalog->describeTable(['namespace' => $namespace, 'name' => $name]);
            try {
                $this->catalog->insertRow($metadata, [
                    'id' => 2,
                    't0' => '12:34:56',
                    'dt0' => '2026-01-02 03:04:05',
                    't3' => '12:34:56.1234',
                    'dt3' => '2026-01-02 03:04:05.1234',
                ]);
                self::fail('a typed temporal write beyond declared precision succeeded');
            } catch (OrmException) {
                $quoted = $this->quote($name);
                $count = $this->catalog->readOnlyQuery(
                    "SELECT COUNT(*) FROM {$quoted} WHERE id=2",
                    [],
                );
                self::assertSame(0, (int) $count->rows[0][0]);
            }
            $t0 = $this->driver === 'postgres' ? '12:34:56.123456' : '12:34:56';
            $dt0 = $this->driver === 'postgres' ? '2026-01-02 03:04:05.123456' : '2026-01-02 03:04:05';
            $inserted = $this->catalog->insertRow($metadata, [
                'id' => 1,
                't0' => $t0,
                'dt0' => $dt0,
                't3' => '12:34:56.123',
                'dt3' => '2026-01-02 03:04:05.123',
            ]);
            self::assertCount(1, $inserted->rows);
            $page = $this->catalog->tablePage(['namespace' => $namespace, 'name' => $name], 1, 0);
            $values = array_slice($page->result->rows[0], 1);
            $fractionDigits = array_map(static function (string $value): int {
                $dot = strpos($value, '.');
                return $dot === false ? 0 : strlen(substr($value, $dot + 1));
            }, $values);
            self::assertSame(
                $this->driver === 'mysql' || $this->driver === 'sqlite' ? [0, 0, 3, 3] : [6, 6, 3, 3],
                $fractionDigits,
                "{$this->driver}: temporal table reads use the native default or declared precision"
            );
        };
        $this->withTemporaryCatalogTable('catalog_temporal_precision_', $columns, $assert);

        if ($this->driver === 'mysql') {
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
    }

    // Requirements: SCH-6a.
    public function testGridColumnAndRowOrder(): void
    {
        $result = $this->catalog->readOnlyGridQuery(
            "SELECT 1 AS seq, 'a' AS label UNION ALL SELECT 2, 'b' UNION ALL SELECT 3, 'c' "
            . "UNION ALL SELECT 4, 'd' ORDER BY seq DESC"
        );
        self::assertSame(['seq', 'label'], $result->columns);
        $rows = array_map(
            static fn (array $row): array => array_map(
                static fn (CatalogGridCell $cell): array => [$cell->kind, $cell->value],
                $row
            ),
            $result->rows
        );
        self::assertSame([
            [['integer', 4], ['text', 'd']],
            [['integer', 3], ['text', 'c']],
            [['integer', 2], ['text', 'b']],
            [['integer', 1], ['text', 'a']],
        ], $rows);
    }

    protected function assertPlainQueryBounds(): void
    {
        $catalog = $this->catalog ?? throw new \LogicException('catalog connection is not set');
        $rows = "SELECT 'alpha' AS value UNION ALL SELECT 'beta' AS value";
        try {
            $catalog->readOnlyQuery($rows, [], 1, 128);
            self::fail('a plain query over its row limit returned partial success');
        } catch (OrmException $e) {
            self::assertSame(Code::CATALOG_LIMIT, $e->code_);
            self::assertSame('CATALOG_LIMIT: result has more than 1 rows', $e->getMessage());
        }
        self::assertSame([['alpha'], ['beta']], $catalog->readOnlyQuery($rows, [], 2, 128)->rows);

        $bytes = "SELECT 'abc' AS value";
        try {
            $catalog->readOnlyQuery($bytes, [], 2, 2);
            self::fail('a plain query over its byte limit returned partial success');
        } catch (OrmException $e) {
            self::assertSame(Code::CATALOG_LIMIT, $e->code_);
            self::assertSame('CATALOG_LIMIT: result has more than 2 bytes of values', $e->getMessage());
        }
        self::assertSame([['abc']], $catalog->readOnlyQuery($bytes, [], 2, 3)->rows);
    }

    // Requirements: COD-31, INT-4, INT-8.
    public function testModelReadNullAndEmptyText(): void
    {
        $this->assertModelImplementation();
        $seq = -1_000_000_000_000 - random_int(0, 1_000_000_000);
        $targets = [$seq, $seq - 1];
        $catalog = $this->catalog ?? throw new \LogicException('catalog connection is not set');
        $table = ['namespace' => $catalog->currentNamespace(), 'name' => 'bind_cell'];
        $metadata = $catalog->describeTable($table);
        $db = Model\connect(
            (string) getenv('ORM_FEATURE_DSN'),
            new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index')
        );
        try {
            $catalog->insertRow($metadata, ['seq' => $seq, 'label' => 'null-v', 'body' => null]);
            $catalog->insertRow($metadata, ['seq' => $seq - 1, 'label' => 'empty', 'body' => '']);

            $nullRead = (new Model\BindCell())($db)->seq($seq)->get();
            $emptyRead = (new Model\BindCell())($db)->seq($seq - 1)->get();
            self::assertNull($nullRead->getBody(), 'SQL NULL remains null when read through the model');
            self::assertSame(
                '',
                $emptyRead->getBody(),
                'empty text remains an empty string when read through the model',
            );
            try {
                Codec::decode(['ordered_json'], '');
                self::fail('empty text with ordered_json was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
            }
        } finally {
            $snapshots = [];
            for ($offset = 0;;) {
                $page = $catalog->tablePage($table, 1000, $offset);
                $keyIndex = $page->columnIndex('seq');
                foreach ($page->result->rows as $index => $row) {
                    if (in_array($row[$keyIndex], $targets, true)) {
                        $snapshots[] = $catalog->rowSnapshotFromPage($page, $index);
                    }
                }
                if (!$page->hasMore) {
                    break;
                }
                $offset += count($page->result->rows);
            }
            foreach ($snapshots as $snapshot) {
                $catalog->deleteRow($snapshot);
            }
            $db->close();
        }
    }

    // Requirements: DBS-113, INT-34, INT-106, INT-108, INT-109, INT-110, INT-111.
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
        $page = $this->catalog->tablePage($table, 1000, 0);
        $wrongOrder = new CatalogTablePage(
            $page->metadata,
            $page->result,
            $page->limit,
            $page->offset,
            [],
            $page->hasMore,
        );
        try {
            $this->catalog->rowSnapshotFromPage($wrongOrder, 0);
            self::fail('a snapshot page with an order that differs from the descriptor was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::ROW_SNAPSHOT_INVALID, $error->code_);
        }
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
        $original = $find('catalog');
        self::assertSame(['tenant_id', 'account_id'], $original->metadata->primaryKey);
        self::assertSame([0, 1], $original->keyIndexes);
        $originalCells = $original->cells;
        $originalRevision = $original->revision();
        foreach (
            [
                ['absent' => 'value'],
                ['name' => null],
                ['name' => str_repeat('x', 192)],
            ] as $invalid
        ) {
            try {
                $this->catalog->updateRow($original, $invalid);
                self::fail('an invalid row update was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::ROW_UPDATE_INVALID, $error->code_);
            }
        }
        self::assertSame($originalRevision, $find('catalog')->revision());
        $updated = $this->catalog->updateRow($original, ['name' => 'catalog-updated']);
        self::assertCount(1, $updated->rows);
        self::assertSame($originalCells, $original->cells);
        self::assertSame($originalRevision, $original->revision());
        try {
            $this->catalog->updateRow($original, ['name' => 'stale']);
            self::fail('a stale row snapshot was accepted for update');
        } catch (OrmException $error) {
            self::assertSame(Code::ROW_CONFLICT, $error->code_);
        }
        $updatedName = $this->catalog->readOnlyQuery(
            "SELECT name FROM {$account} WHERE tenant_id = " . self::TENANT . ' AND account_id = 1',
            [],
        )->rows[0][0];
        self::assertSame('catalog-updated', $updatedName);
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
