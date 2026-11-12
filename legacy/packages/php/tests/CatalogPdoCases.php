<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use ReflectionClass;
use ReflectionProperty;
use RuntimeException;

/**
 * The catalog cases on a PDO that the caller hands the catalog, which the PHP library and the PHP extension share
 * (FCV-2): a throwable of that PDO which is no PDOException reaches the caller as it is, and no other runtime has this
 * surface; a MariaDB default that no server writes is read from that PDO.
 */
trait CatalogPdoCases
{
    // Requirements: DIA-205. A quoted MariaDB default that is not one whole literal is TABLE_METADATA_INVALID; no
    // server writes one, so the recipes cannot hold it (FCV-2).
    public function testAMariadbDefaultThatIsNotOneLiteralIsMetadataInvalid(): void
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

    // Requirements: PRT-79.
    public function testCatalogPassesAThrowableThatIsNoDriverErrorThrough(): void
    {
        // The library catches only \PDOException around a driver call: any other throwable of the call, such as the
        // interrupt of a time limit, reaches the caller as it is, and a PDOException is still mapped.
        $interrupt = new \RuntimeException('interrupted');
        foreach ([$interrupt, new \PDOException('no such table')] as $failure) {
            $pdo = new class ([], $failure) extends CatalogMariadbDefaultPdo {
                public function __construct(array $defaults, private readonly \Throwable $failure)
                {
                    parent::__construct($defaults);
                }

                public function answer(string $query): array
                {
                    if (str_starts_with($query, 'SELECT c.COLUMN_NAME,')) {
                        throw $this->failure;
                    }
                    return parent::answer($query);
                }
            };
            $db = new Db($pdo, 'mysql', new Config(), new DateTimeZone('UTC'));
            $db->setServer('mariadb');
            try {
                self::catalogWith($db, 'mysql')
                    ->describeTable(['namespace' => 'orm_test', 'name' => 'default_probe']);
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

    // Requirements: INT-118, PRT-79.
    public function testInsertCommitFailurePassesARollbackThrowableThatIsNoDriverErrorThrough(): void
    {
        // The library catches only \PDOException around the cleanup ROLLBACK of an unknown commit outcome: any other
        // throwable of it, such as the interrupt of a time limit, reaches the caller as it is.
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
                self::fail('an unconfirmed insert commit returned success');
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
}
