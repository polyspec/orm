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

    // Requirements: INT-109. The recipe case descriptor_column_name holds the code and the message in every runtime; the
    // previous exception is the form of the cause that only PHP has.
    public function testInvalidDescriptorKeepsTheColumnNameFailureAsItsPrevious(): void
    {
        $metadata = new CatalogTableMetadata(
            ['namespace' => 'main', 'name' => 'sample'],
            'table',
            [new CatalogColumn("\xFF", 'text', false, false, false, null, false)],
            ["\xFF"],
            true,
        );
        try {
            (new \ReflectionMethod(Catalog::class, 'descriptorKeys'))->invoke(null, $metadata);
            self::fail('a descriptor with a non-UTF-8 column name was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::ROW_SNAPSHOT_INVALID, $error->code_);
            self::assertInstanceOf(OrmException::class, $error->getPrevious());
            self::assertSame(Code::TABLE_REFERENCE_INVALID, $error->getPrevious()->code_);
        }
    }

    // Requirements: INT-103, INT-117.
    public function testDescribedPostgresTemporalCellsHaveTheirDeclaredPrecision(): void
    {
        CatalogPostgresTemporalCases::assertDeclaredPrecision(
            static function (CatalogPostgresTemporalPdo $pdo): Catalog {
                $db = new Db($pdo, 'postgres', new Config(), new \DateTimeZone('UTC'));
                $catalog = (new \ReflectionClass(Catalog::class))->newInstanceWithoutConstructor();
                (new \ReflectionProperty(Catalog::class, 'db'))->setValue($catalog, $db);
                (new \ReflectionProperty(Catalog::class, 'dialect'))->setValue($catalog, 'postgres');
                return $catalog;
            },
        );
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
}
