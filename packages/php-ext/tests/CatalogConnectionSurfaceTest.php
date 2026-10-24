<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// DB-free native tests for the Catalog DTOs and the extension's public connection boundary.

use DateTimeZone;
use Error;
use PDO;
use PDOException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
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
use ReflectionClass;
use ReflectionProperty;
use RuntimeException;
use mysqli;

final class CatalogMetadataFailurePdo extends PDO
{
    /** @var list<string> */
    public array $statements = [];

    public function __construct()
    {
    }

    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function exec(string $statement): int|false
    {
        $this->statements[] = $statement;
        return 0;
    }

    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        return new CatalogMetadataFailureStatement();
    }
}

final class CatalogMetadataFailureStatement extends \PDOStatement
{
    public static ?PDOException $failure = null;

    public function __construct()
    {
    }

    public function execute(?array $params = null): bool
    {
        return true;
    }

    public function columnCount(): int
    {
        return 3;
    }

    public function getColumnMeta(int $column): array|false
    {
        if ($column === 1) {
            throw self::$failure ?? new PDOException('column metadata failed');
        }
        return ['name' => "column_$column", 'native_type' => 'INTEGER'];
    }
}

final class CatalogCommitFailureLink extends \mysqli
{
    public int $rollbackCalls = 0;

    public function __construct(private readonly bool $failRollback)
    {
    }

    public function begin_transaction(int $flags = MYSQLI_TRANS_START_READ_WRITE, ?string $name = null): bool
    {
        return true;
    }

    public function prepare(string $query): \mysqli_stmt|false
    {
        return new CatalogCommitFailureStatement();
    }

    public function commit(int $flags = 0, ?string $name = null): bool
    {
        throw new \mysqli_sql_exception('grid commit failed');
    }

    public function rollback(int $flags = 0, ?string $name = null): bool
    {
        $this->rollbackCalls++;
        if ($this->failRollback) {
            throw new \mysqli_sql_exception('grid rollback failed');
        }
        return true;
    }
}

final class CatalogCommitFailureStatement extends \mysqli_stmt
{
    public function __construct()
    {
    }

    public function execute(?array $params = null): bool
    {
        return true;
    }

    public function get_result(): \mysqli_result|false
    {
        return new CatalogCommitFailureResult();
    }
}

final class CatalogCommitFailureResult extends \mysqli_result
{
    private bool $fetched = false;

    public function __construct()
    {
    }

    public function fetch_fields(): array
    {
        return [(object) ['name' => 'value', 'type' => MYSQLI_TYPE_LONG, 'flags' => 0, 'charsetnr' => 63]];
    }

    public function fetch_row(): array|null|false
    {
        if ($this->fetched) {
            return null;
        }
        $this->fetched = true;
        return [1];
    }
}

#[Small]
final class CatalogConnectionSurfaceTest extends TestCase
{
    public function testNativeGridCellsPreserveDeclaredValues(): void
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

    public function testNativeTablePageIndexesColumnsAndReportsUnknownName(): void
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

    public function testNativeConnectRejectsNonDatabaseDsn(): void
    {
        self::assertTrue((new \ReflectionClass(Catalog::class))->isInternal());
        try {
            Catalog::connect('markdown://corpus');
            self::fail('a non-database DSN created a catalog connection');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
        }
    }

    public function testNativeGridMetadataFailureReleasesOnlyInitializedColumnTypes(): void
    {
        $failure = new PDOException('column metadata failed');
        CatalogMetadataFailureStatement::$failure = $failure;
        $pdo = new CatalogMetadataFailurePdo();
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $catalog = self::catalogWith($db, 'sqlite');

        try {
            $catalog->readOnlyGridQuery('SELECT 1 AS first, 2 AS second, 3 AS third');
            self::fail('a failed column metadata read returned a grid');
        } catch (OrmException $error) {
            self::assertSame(Code::DRIVER, $error->code_);
            self::assertSame('DRIVER: column metadata failed', $error->getMessage());
            self::assertSame($failure, $error->getPrevious());
        } finally {
            CatalogMetadataFailureStatement::$failure = null;
        }
        self::assertContains('ROLLBACK', $pdo->statements);
    }

    public function testNativeGridCommitFailureRollsBackAndComposesRollbackFailure(): void
    {
        $link = new CatalogCommitFailureLink(true);
        $db = new Db(new CatalogMetadataFailurePdo(), 'mysql', new Config(), new DateTimeZone('UTC'));
        $catalog = self::catalogWith($db, 'mysql');
        (new ReflectionProperty(Catalog::class, 'gridLink'))->setValue($catalog, $link);

        try {
            $catalog->readOnlyGridQuery('SELECT 1 AS value');
            self::fail('a failed grid commit returned a result');
        } catch (OrmException $error) {
            self::assertSame(Code::ROLLBACK, $error->code_);
            self::assertSame(1, $link->rollbackCalls);
            self::assertInstanceOf(OrmException::class, $error->getPrevious());
            self::assertSame(Code::DRIVER, $error->getPrevious()->code_);
            self::assertInstanceOf(\mysqli_sql_exception::class, $error->getPrevious()->getPrevious());
            self::assertInstanceOf(OrmException::class, $error->rollback);
            self::assertSame(Code::DRIVER, $error->rollback->code_);
            self::assertInstanceOf(\mysqli_sql_exception::class, $error->rollback->getPrevious());
        }
    }

    private static function catalogWith(Db $db, string $dialect): Catalog
    {
        $catalog = (new ReflectionClass(Catalog::class))->newInstanceWithoutConstructor();
        (new ReflectionProperty(Catalog::class, 'db'))->setValue($catalog, $db);
        (new ReflectionProperty(Catalog::class, 'dialect'))->setValue($catalog, $dialect);
        return $catalog;
    }

    public function testNativeCatalogReadsAndMutatesAnOwnedSqliteDatabase(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-catalog-native-');
        self::assertNotFalse($path);
        $setup = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $setup->exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, payload BLOB NOT NULL, note TEXT NULL)');
        $setup->exec("INSERT INTO sample (id, payload, note) VALUES (1, X'00ff', NULL), (2, X'6162', 'two')");
        $setup->exec('CREATE TABLE catalog_control (ignore_sample_delete INTEGER NOT NULL)');
        $setup->exec('INSERT INTO catalog_control (ignore_sample_delete) VALUES (0)');
        $setup->exec(
            'CREATE TRIGGER ignore_sample_delete BEFORE DELETE ON sample '
            . 'WHEN (SELECT ignore_sample_delete FROM catalog_control) = 1 '
            . 'BEGIN SELECT RAISE(IGNORE); END'
        );
        $setup->exec('CREATE TABLE required_identity (id BIGINT NOT NULL PRIMARY KEY, payload TEXT NOT NULL)');
        $setup->exec('CREATE TABLE generated (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
        $setup->exec(
            "CREATE TABLE generated_default (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', "
            . 'n BIGINT NOT NULL, PRIMARY KEY (tenant, seq))'
        );
        $setup->exec(
            'CREATE TABLE generated_expression (seq TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), '
            . 'n BIGINT NOT NULL UNIQUE, label VARCHAR(20) NULL)'
        );
        $setup = null;

        $catalog = null;
        try {
            $catalog = Catalog::connect('sqlite://' . $path);
            self::assertSame('main', $catalog->currentNamespace());
            $requiredMetadata = $catalog->describeTable(['namespace' => 'main', 'name' => 'required_identity']);
            try {
                $catalog->insertRow($requiredMetadata, ['payload' => 'missing-key']);
                self::fail('an omitted primary key without a generator was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::ROW_INSERT_IDENTITY_REQUIRED, $error->code_);
            }
            $table = ['namespace' => 'main', 'name' => 'sample'];
            $metadata = $catalog->describeTable($table);
            self::assertSame(['id'], $metadata->primaryKey);
            self::assertTrue($metadata->reliableRowIdentity);
            $generatedTable = ['namespace' => 'main', 'name' => 'generated'];
            $generatedMetadata = $catalog->describeTable($generatedTable);
            self::assertSame(['id'], $generatedMetadata->primaryKey);
            self::assertSame('INTEGER', $generatedMetadata->columns[0]->nativeType);
            self::assertFalse($generatedMetadata->columns[0]->nullable);
            self::assertFalse($generatedMetadata->columns[0]->generated);
            self::assertTrue($generatedMetadata->columns[0]->automaticKey);
            self::assertNull($generatedMetadata->columns[0]->defaultExpression);
            self::assertFalse($generatedMetadata->columns[0]->expressionDefault);
            $generated = $catalog->insertRow($generatedMetadata, ['payload' => 'generated']);
            self::assertSame(['id', 'payload'], $generated->columns);
            self::assertSame([[1, 'generated']], $generated->rows);
            $generatedDefaultMetadata = $catalog->describeTable(['namespace' => 'main', 'name' => 'generated_default']);
            self::assertSame(['tenant', 'seq'], $generatedDefaultMetadata->primaryKey);
            self::assertSame("'generated'", $generatedDefaultMetadata->columns[1]->defaultExpression);
            self::assertFalse($generatedDefaultMetadata->columns[1]->automaticKey);
            $generatedDefault = $catalog->insertRow(
                $generatedDefaultMetadata,
                ['tenant' => 2, 'n' => 50]
            );
            self::assertSame(['tenant', 'seq', 'n'], $generatedDefault->columns);
            self::assertSame([[2, 'generated', 50]], $generatedDefault->rows);
            $generatedExpressionMetadata = $catalog->describeTable(
                ['namespace' => 'main', 'name' => 'generated_expression']
            );
            self::assertSame(['seq'], $generatedExpressionMetadata->primaryKey);
            self::assertTrue($generatedExpressionMetadata->columns[0]->expressionDefault);
            $generatedExpression = $catalog->insertRow(
                $generatedExpressionMetadata,
                ['n' => 1, 'label' => null]
            );
            $storedExpression = $catalog->tablePage(
                ['namespace' => 'main', 'name' => 'generated_expression'],
                2,
                0
            );
            self::assertCount(1, $generatedExpression->rows);
            self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', $generatedExpression->rows[0][0]);
            self::assertSame([1, null], array_slice($generatedExpression->rows[0], 1));
            self::assertSame($storedExpression->result->rows, $generatedExpression->rows);

            $page = $catalog->tablePage($table, 1, 0);
            self::assertSame(['id'], $page->orderBy);
            self::assertTrue($page->hasMore);
            self::assertSame([1, "\x00\xff", null], $page->result->rows[0]);

            $query = $catalog->readOnlyQuery('SELECT COUNT(*) AS count FROM sample');
            self::assertSame(2, $query->rows[0][0]);
            $grid = $catalog->readOnlyGridQuery(
                "SELECT 7 AS integer_value, X'00ff' AS binary_value, NULL AS null_value"
            );
            self::assertEquals(
                [
                    new CatalogGridCell('integer', 7),
                    new CatalogGridCell('binary', "\x00\xff"),
                    new CatalogGridCell('null'),
                ],
                $grid->rows[0]
            );
            try {
                $catalog->readOnlyGridQuery('SELECT 1 AS value UNION ALL SELECT 2', [], 1);
                self::fail('a grid result over the row limit was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CATALOG_LIMIT, $error->code_);
                self::assertSame('CATALOG_LIMIT: result has more than 1 rows', $error->getMessage());
            }
            try {
                $catalog->readOnlyGridQuery("SELECT 'too large' AS value", [], 10, 1);
                self::fail('a grid result over the byte limit was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CATALOG_LIMIT, $error->code_);
                self::assertSame('CATALOG_LIMIT: result has more than 1 bytes of values', $error->getMessage());
            }
            try {
                $catalog->readOnlyQuery('UPDATE sample SET note = note WHERE id = 1');
                self::fail('a write was accepted by the read-only query');
            } catch (OrmException $error) {
                self::assertSame(Code::QUERY_READ_ONLY, $error->code_);
            }

            $inserted = $catalog->insertRow($metadata, ['payload' => 'three', 'note' => null]);
            self::assertSame([3, 'three', null], $inserted->rows[0]);
            $afterInsert = $catalog->tablePage($table, 10, 0);
            $idColumn = $afterInsert->columnIndex('id');
            $rowIndex = null;
            foreach ($afterInsert->result->rows as $index => $row) {
                if ($row[$idColumn] === 3) {
                    $rowIndex = $index;
                    break;
                }
            }
            self::assertNotNull($rowIndex);
            $snapshot = $catalog->rowSnapshotFromPage($afterInsert, $rowIndex);
            $updated = $catalog->updateRow($snapshot, ['note' => 'updated']);
            self::assertSame([3, 'three', 'updated'], $updated->rows[0]);
            $afterUpdate = $catalog->tablePage($table, 10, 0);
            $updatedIndex = null;
            foreach ($afterUpdate->result->rows as $index => $row) {
                if ($row[$afterUpdate->columnIndex('id')] === 3) {
                    $updatedIndex = $index;
                    break;
                }
            }
            self::assertNotNull($updatedIndex);
            $control = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $control->exec('UPDATE catalog_control SET ignore_sample_delete = 1');
            try {
                $catalog->deleteRow($catalog->rowSnapshotFromPage($afterUpdate, $updatedIndex));
                self::fail('a delete that affected no rows was accepted');
            } catch (\Polyspec\Orm\OrmException $error) {
                self::assertSame(Code::ROW_WRITE_MISMATCH, $error->code_);
                self::assertSame('ROW_WRITE_MISMATCH: expected exactly one deleted row, got 0', $error->getMessage());
            }
            self::assertSame(1, (int) $control->query('SELECT COUNT(*) FROM sample WHERE id = 3')->fetchColumn());
            $control->exec('UPDATE catalog_control SET ignore_sample_delete = 0');
            $control = null;
            self::assertSame(
                1,
                $catalog->deleteRow($catalog->rowSnapshotFromPage($afterUpdate, $updatedIndex))
            );

            $catalog->close();
            try {
                $catalog->readOnlyQuery('SELECT 1');
                self::fail('a read after close succeeded');
            } catch (OrmException $error) {
                self::assertSame(Code::CATALOG_CLOSED, $error->code_);
            }
        } finally {
            $catalog?->close();
            unlink($path);
        }
    }

    public function testNativeCloseAttemptsBothStepsAndKeepsPrimaryAndCleanupCauses(): void
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

    public function testGeneratedInsertRejectsChangedStoredValueAndRollsBack(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-catalog-generated-');
        self::assertNotFalse($path);
        $setup = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $setup->exec('CREATE TABLE generated (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)');
        $setup->exec(
            "CREATE TRIGGER rewrite_payload AFTER INSERT ON generated BEGIN "
            . "UPDATE generated SET payload = 'rewritten' WHERE id = NEW.id; END"
        );
        $setup = null;

        $catalog = null;
        try {
            $catalog = Catalog::connect('sqlite://' . $path);
            $metadata = $catalog->describeTable(['namespace' => 'main', 'name' => 'generated']);
            try {
                $catalog->insertRow($metadata, ['payload' => 'submitted']);
                self::fail('an insert whose stored value changed was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::ROW_WRITE_MISMATCH, $error->code_);
                self::assertSame(
                    'ROW_WRITE_MISMATCH: stored inserted values of "payload" differ',
                    $error->getMessage()
                );
            }
            $check = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            self::assertSame(0, (int) $check->query('SELECT COUNT(*) FROM generated')->fetchColumn());
        } finally {
            $catalog?->close();
            @unlink($path);
        }
    }
}
