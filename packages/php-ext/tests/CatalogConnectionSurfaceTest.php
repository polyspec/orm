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
    use CatalogThrowableCases;

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

    // Requirements: DIA-205. A quoted MariaDB default that is not one whole literal is TABLE_METADATA_INVALID; no
    // server writes one, so the recipes cannot hold it (FCV-2).
    public function testNativeMariadbDefaultThatIsNotOneLiteralIsMetadataInvalid(): void
    {
        foreach (["'a' 'b'", "'unterminated", "'a'x"] as $text) {
            $pdo = new CatalogMariadbDefaultPdo([['broken', $text]]);
            $db = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
            $db->setServer('mariadb');
            try {
                self::catalogWith($db, 'mysql')->describeTable(['namespace' => 'orm_test', 'name' => 'default_probe']);
                self::fail("the default {$text} was described");
            } catch (OrmException $error) {
                self::assertSame(Code::TABLE_METADATA_INVALID, $error->code_, $text);
                self::assertSame(
                    "TABLE_METADATA_INVALID: column \"broken\": default {$text} is not one string literal",
                    $error->getMessage(),
                );
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
