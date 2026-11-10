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

#[Small]
final class CatalogConnectionSurfaceTest extends TestCase
{
    // Requirements: INT-103, INT-117.
    public function testNativeDescribedPostgresTemporalCellsHaveTheirDeclaredPrecision(): void
    {
        CatalogPostgresTemporalCases::assertDeclaredPrecision(
            static function (CatalogPostgresTemporalPdo $pdo): Catalog {
                return self::catalogWith(new Db($pdo, 'postgres', new Config(), new DateTimeZone('UTC')), 'postgres');
            },
        );
    }

    // Requirements: INT-165, INT-171. No server sends a datetime text for a date column.
    public function testNativeDescribedPostgresDriverValueOfNoConversionIsRefused(): void
    {
        CatalogPostgresTemporalCases::assertUnsupportedDriverValue(
            static function (CatalogPostgresTemporalPdo $pdo): Catalog {
                return self::catalogWith(new Db($pdo, 'postgres', new Config(), new DateTimeZone('UTC')), 'postgres');
            },
        );
    }

    // Requirements: INT-165, INT-172. No server sends a bytea stream that cannot be read.
    public function testNativeDescribedPostgresUndecodableDriverValueKeepsItsCause(): void
    {
        CatalogPostgresTemporalCases::assertUndecodableDriverValue(
            static function (CatalogPostgresTemporalPdo $pdo): Catalog {
                return self::catalogWith(new Db($pdo, 'postgres', new Config(), new DateTimeZone('UTC')), 'postgres');
            },
        );
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

    // Requirements: INT-121.
    public function testNativeTablePagePreparedColumnsDifferFromTheDescriptor(): void
    {
        $pdo = new CatalogPageMutationPdo('prepared');
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $catalog = self::catalogWith($db, 'sqlite');
        try {
            $catalog->tablePage(['namespace' => 'main', 'name' => 'page_probe'], 1, 0);
            self::fail('native table page accepted prepared columns that differ from the descriptor');
        } catch (OrmException $error) {
            self::assertSame(Code::TABLE_PAGE_METADATA_CHANGED, $error->code_);
            self::assertSame(
                'TABLE_PAGE_METADATA_CHANGED: prepared columns differ from descriptor',
                $error->getMessage()
            );
        }
        self::assertContains('ROLLBACK', $pdo->statements);
    }

    // Requirements: INT-109. The recipe case descriptor_column_name holds the code and the message in every runtime;
    // the previous exception is the form of the cause that only PHP has.
    public function testNativeInvalidDescriptorKeepsTheColumnNameFailureAsItsPrevious(): void
    {
        $catalog = (new ReflectionClass(Catalog::class))->newInstanceWithoutConstructor();
        $read = static function (CatalogTableMetadata $metadata) use ($catalog): void {
            $page = new CatalogTablePage(
                $metadata,
                new CatalogResult(["\xFF"], [['value']]),
                10,
                0,
                ["\xFF"],
                false,
            );
            $catalog->rowSnapshotFromPage($page, 0);
        };
        coverageAssertColumnNameFailureIsPrevious($read);
    }

    // Requirements: DIA-205. A MariaDB server writes COLUMN_DEFAULT as SQL text, which the descriptor reads in the MySQL form:
    // 'NULL' is no default, a quoted literal its value with its escapes undone, a number itself, and any other text an
    // expression default, the clock as CURRENT_TIMESTAMP(p); on a MySQL server the same text is the default as it is.
    public function testNativeMariadbColumnDefaultIsReadInTheMysqlForm(): void
    {
        require_once __DIR__ . '/CatalogMariadbDefaultPdo.php';
        $defaults = [
            ['none', null], ['null_text', 'NULL'], ['quoted', "'it''s'"], ['number', '-1.5e3'],
            ['clock', 'current_timestamp(3)'], ['clock0', 'current_timestamp()'], ['expression', 'uuid()'],
        ];
        $want = [
            'mariadb' => [
                [null, false], [null, false], ["it's", false], ['-1.5e3', false],
                ['CURRENT_TIMESTAMP(3)', true], ['CURRENT_TIMESTAMP', true], ['uuid()', true],
            ],
            'mysql' => [
                [null, false], ['NULL', false], ["'it''s'", false], ['-1.5e3', false],
                ['current_timestamp(3)', false], ['current_timestamp()', false], ['uuid()', false],
            ],
        ];
        foreach ($want as $server => $columns) {
            $db = new Db(new CatalogMariadbDefaultPdo($defaults), 'mysql', new Config(), new DateTimeZone('UTC'));
            $db->setServer($server);
            $metadata = self::catalogWith($db, 'mysql')->describeTable(['namespace' => 'orm_test', 'name' => 'default_probe']);
            $read = array_map(
                static fn (CatalogColumn $column): array => [$column->defaultExpression, $column->expressionDefault],
                array_slice($metadata->columns, 1),
            );
            self::assertSame($columns, $read, $server);
        }

        // A quoted text that is not one whole literal is no default that the descriptor can state.
        $db = new Db(new CatalogMariadbDefaultPdo([['broken', "'a' 'b'"]]), 'mysql', new Config(), new DateTimeZone('UTC'));
        $db->setServer('mariadb');
        try {
            self::catalogWith($db, 'mysql')->describeTable(['namespace' => 'orm_test', 'name' => 'default_probe']);
            self::fail('a default that is not one string literal was described');
        } catch (OrmException $error) {
            self::assertSame(Code::TABLE_METADATA_INVALID, $error->code_);
            self::assertSame(
                "TABLE_METADATA_INVALID: column \"broken\": default 'a' 'b' is not one string literal",
                $error->getMessage(),
            );
        }
    }

    public function testNativeCatalogPassesAThrowableThatIsNoDriverErrorThrough(): void
    {
        // The library catches only \PDOException around a driver call: any other throwable of the call, such as the
        // interrupt of a time limit, reaches the caller as it is, and a PDOException is still mapped.
        require_once __DIR__ . '/CatalogMariadbDefaultPdo.php';
        $interrupt = new \RuntimeException('interrupted');
        foreach ([$interrupt, new \PDOException('no such table')] as $failure) {
            $pdo = new class ([], $failure) extends CatalogMariadbDefaultPdo {
                public function __construct(array $defaults, private readonly \Throwable $failure)
                {
                    parent::__construct($defaults);
                }

                public function answer(string $query): array
                {
                    if (str_starts_with($query, 'SELECT c.COLUMN_NAME,c.COLUMN_TYPE')) {
                        throw $this->failure;
                    }
                    return parent::answer($query);
                }
            };
            $db = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
            $db->setServer('mariadb');
            try {
                self::catalogWith($db, 'mysql')->describeTable(['namespace' => 'orm_test', 'name' => 'default_probe']);
                self::fail('a failed columns read was described');
            } catch (\Throwable $thrown) {
                if ($failure === $interrupt) {
                    self::assertSame($interrupt, $thrown);
                } else {
                    self::assertInstanceOf(OrmException::class, $thrown);
                    self::assertSame($failure, $thrown->getPrevious());
                }
            }
        }
    }

    public function testNativeGridMetadataFailureReleasesOnlyInitializedColumnTypes(): void
    {
        require_once __DIR__ . '/CatalogMetadataFailurePdo.php';
        require_once __DIR__ . '/CatalogMetadataFailureStatement.php';
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

    // Requirements: INT-118, PRT-79.
    public function testNativeInsertCommitFailurePreservesTheDriverCause(): void
    {
        self::assertIndeterminateInsert(false, static function (OrmException $error, CatalogCommitFaultPdo $pdo): void {
            self::assertSame('commit lost after the insert', $error->getPrevious()->getPrevious()->getMessage());
            self::assertSame(0, (int) $pdo->query('SELECT COUNT(*) FROM sample')->fetchColumn());
        });
    }

    // Requirements: INT-118, PRT-79.
    public function testNativeInsertCommitAndRollbackFailuresPreserveBothDriverCauses(): void
    {
        self::assertIndeterminateInsert(true, static function (OrmException $error, CatalogCommitFaultPdo $pdo): void {
            self::assertStringContainsString('rollback failed', $error->getMessage());
            self::assertInstanceOf(OrmException::class, $error->rollback);
            self::assertSame(Code::DRIVER, $error->rollback->code_);
            self::assertSame($pdo->rollbackFailure, $error->rollback->getPrevious());
            self::assertTrue($pdo->inTransaction(), 'the injected rollback failure leaves the SQLite transaction open');
            self::assertSame(1, (int) $pdo->query('SELECT COUNT(*) FROM sample')->fetchColumn());
        });
    }

    public function testNativeInsertCommitFailurePassesARollbackThrowableThatIsNoDriverErrorThrough(): void
    {
        // The library catches only \PDOException around the cleanup ROLLBACK of an unknown commit outcome: any other
        // throwable of it, such as the interrupt of a time limit, reaches the caller as it is.
        require_once __DIR__ . '/CatalogCommitFaultPdo.php';
        $pdo = new CatalogCommitFaultPdo();
        $pdo->exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
        $interrupt = new RuntimeException('interrupted');
        $pdo->rollbackFailure = $interrupt;
        $catalog = null;
        try {
            [$catalog, $metadata] = self::sqliteCatalog($pdo, 'sample');
            $pdo->failCommit = true;
            $pdo->failRollback = true;
            try {
                $catalog->insertRow($metadata, ['id' => 1, 'payload' => 'inserted']);
                self::fail('an unconfirmed native insert commit returned success');
            } catch (\Throwable $thrown) {
                self::assertSame($interrupt, $thrown);
            }
        } finally {
            if ($pdo->inTransaction()) {
                $pdo->exec('ROLLBACK');
            }
            $catalog?->close();
        }
    }

    /**
     * Inserts a sample row through the native SQLite catalog while its COMMIT fails, and its cleanup ROLLBACK too when
     * $failRollback: the insert reports ROW_COMMIT_INDETERMINATE whose cause is the DRIVER error of the commit failure.
     * $check receives that error and the PDO before the catalog closes.
     *
     * @param \Closure(OrmException, CatalogCommitFaultPdo): void $check
     */
    private static function assertIndeterminateInsert(bool $failRollback, \Closure $check): void
    {
        self::assertTrue((new ReflectionClass(Catalog::class))->isInternal());
        self::assertTrue((new ReflectionClass(Catalog::class))->getMethod('insertRow')->isInternal());

        require_once __DIR__ . '/CatalogCommitFaultPdo.php';
        $pdo = new CatalogCommitFaultPdo();
        $pdo->exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
        $catalog = null;

        try {
            [$catalog, $metadata] = self::sqliteCatalog($pdo, 'sample');
            $pdo->failCommit = true;
            $pdo->failRollback = $failRollback;
            try {
                $catalog->insertRow($metadata, ['id' => 1, 'payload' => 'inserted']);
                self::fail('an unconfirmed native insert commit returned success');
            } catch (OrmException $error) {
                self::assertSame(Code::ROW_COMMIT_INDETERMINATE, $error->code_);
                self::assertStringContainsString('commit outcome unknown; do not retry', $error->getMessage());
                self::assertInstanceOf(OrmException::class, $error->getPrevious());
                self::assertSame(Code::DRIVER, $error->getPrevious()->code_);
                self::assertSame($pdo->commitFailure, $error->getPrevious()->getPrevious());
                $check($error, $pdo);
            }
        } finally {
            if ($pdo->inTransaction()) {
                $pdo->exec('ROLLBACK');
            }
            $catalog?->close();
        }
    }

    private static function catalogWith(Db $db, string $dialect): Catalog
    {
        $catalog = (new ReflectionClass(Catalog::class))->newInstanceWithoutConstructor();
        (new ReflectionProperty(Catalog::class, 'db'))->setValue($catalog, $db);
        (new ReflectionProperty(Catalog::class, 'dialect'))->setValue($catalog, $dialect);
        return $catalog;
    }

    /** @return array{Catalog, CatalogTableMetadata} */
    private static function sqliteCatalog(PDO $pdo, string $table): array
    {
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $catalog = self::catalogWith($db, 'sqlite');
        return [$catalog, $catalog->describeTable(['namespace' => 'main', 'name' => $table])];
    }

    // The recipes hold the rows of these inserts and the key `defaults` of a description; the text of a default and
    // the flag of an expression default have no recipe key (generated_identity_sqlite, generated_key_lifecycle).
    public function testNativeDescribedDefaultsKeepTheirExpressionText(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-catalog-native-');
        self::assertNotFalse($path);
        $setup = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
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
            $generated = $catalog->describeTable(['namespace' => 'main', 'name' => 'generated']);
            self::assertTrue($generated->columns[0]->automaticKey);
            self::assertNull($generated->columns[0]->defaultExpression);
            self::assertFalse($generated->columns[0]->expressionDefault);
            $default = $catalog->describeTable(['namespace' => 'main', 'name' => 'generated_default']);
            self::assertSame("'generated'", $default->columns[1]->defaultExpression);
            self::assertFalse($default->columns[1]->automaticKey);
            $expression = $catalog->describeTable(['namespace' => 'main', 'name' => 'generated_expression']);
            self::assertTrue($expression->columns[0]->expressionDefault);
        } finally {
            $catalog?->close();
            unlink($path);
        }
    }

    public function testNativeCloseAttemptsBothStepsAndKeepsPrimaryAndCleanupCauses(): void
    {
        $db = new Db(new \PDO('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
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

        try {
            $catalog->close();
            self::fail('the cleanup failure was ignored');
        } catch (RuntimeException $error) {
            self::assertSame('database cleanup failed', $error->getMessage());
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
