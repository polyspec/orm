<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\CatalogColumn;
use Polyspec\Orm\CatalogTableMetadata;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

#[Small]
final class CatalogPageValidationTest extends TestCase
{
    public function testLibraryCatalogIsAPhpClass(): void
    {
        self::assertFalse((new \ReflectionClass(Catalog::class))->isInternal());
    }

    // Requirements: INT-109. The recipe case descriptor_column_name holds the code and the message in every runtime;
    // the previous exception is the form of the cause that only PHP has.
    public function testInvalidDescriptorKeepsTheColumnNameFailureAsItsPrevious(): void
    {
        coverageAssertColumnNameFailureIsPrevious(static function (CatalogTableMetadata $metadata): void {
            (new \ReflectionMethod(Catalog::class, 'descriptorKeys'))->invoke(null, $metadata);
        });
    }

    // Requirements: INT-103, INT-117.
    public function testDescribedPostgresTemporalCellsHaveTheirDeclaredPrecision(): void
    {
        CatalogPostgresTemporalCases::assertDeclaredPrecision(self::postgresCatalog(...));
    }

    // Requirements: INT-165, INT-171. No server sends a datetime text for a date column.
    public function testDescribedPostgresDriverValueOfNoConversionIsRefused(): void
    {
        CatalogPostgresTemporalCases::assertUnsupportedDriverValue(self::postgresCatalog(...));
    }

    // Requirements: INT-165, INT-172. No server sends a bytea stream that cannot be read.
    public function testDescribedPostgresUndecodableDriverValueKeepsItsCause(): void
    {
        CatalogPostgresTemporalCases::assertUndecodableDriverValue(self::postgresCatalog(...));
    }

    /** A library catalog on a PostgreSQL connection without a server. */
    private static function postgresCatalog(CatalogPostgresTemporalPdo $pdo): Catalog
    {
        $db = new Db($pdo, 'postgres', new Config(), new \DateTimeZone('UTC'));
        $catalog = (new \ReflectionClass(Catalog::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(Catalog::class, 'db'))->setValue($catalog, $db);
        (new \ReflectionProperty(Catalog::class, 'dialect'))->setValue($catalog, 'postgres');
        return $catalog;
    }

    // Requirements: INT-121. What no server can answer: a statement names its columns in the select list, and a server
    // answers with those names.
    public function testPreparedColumnsDifferFromTheDescriptor(): void
    {
        $metadata = new CatalogTableMetadata(
            ['namespace' => 'main', 'name' => 'page_probe'],
            'table',
            [new CatalogColumn('id', 'INTEGER', false, false, false, null, false)],
            ['id'],
            true,
        );

        $sameNames = new \ReflectionMethod(Catalog::class, 'sameNames');
        try {
            $sameNames->invoke(null, ['renamed'], $metadata, Code::TABLE_PAGE_METADATA_CHANGED);
            self::fail('prepared columns that differ from the descriptor were accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::TABLE_PAGE_METADATA_CHANGED, $error->code_);
        }
    }

    // Requirements: DIA-205. A quoted MariaDB default that is not one whole literal is TABLE_METADATA_INVALID; no
    // server writes one, so the recipes cannot hold it (FCV-2).
    public function testAMariadbDefaultThatIsNotOneLiteralIsMetadataInvalid(): void
    {
        $read = new \ReflectionMethod(Catalog::class, 'mariadbColumn');
        foreach (["'a' 'b'", "'unterminated", "'a'x"] as $text) {
            try {
                $read->invoke(null, new CatalogColumn('broken', 'int', true, false, false, $text, false));
                self::fail("the default {$text} was read");
            } catch (OrmException $error) {
                self::assertSame(Code::TABLE_METADATA_INVALID, $error->code_, $text);
                self::assertSame(
                    "TABLE_METADATA_INVALID: column \"broken\": default {$text} is not one string literal",
                    $error->getMessage(),
                );
            }
        }
    }
}
