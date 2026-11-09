<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

/**
 * The cells of a described PostgreSQL table, shared by the library and the extension: temporal cells (INT-103, INT-117)
 * and the driver values that no server sends (INT-171, INT-172).
 */
final class CatalogPostgresTemporalCases
{
    /**
     * A driver value that its conversion does not take is INT-171, named by the position of its column among the
     * described columns: a date column that the driver delivers as a datetime text.
     *
     * @param callable(CatalogPostgresTemporalPdo): Catalog $makeCatalog
     */
    public static function assertUnsupportedDriverValue(callable $makeCatalog): void
    {
        try {
            $makeCatalog(new CatalogPostgresTemporalPdo(
                [['d', 'date']],
                ['2026-06-01 01:02:03'],
            ))->tablePage(['namespace' => 'public', 'name' => 'temporal_probe'], 1, 0);
            Assert::fail('a date column read a datetime text');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CATALOG_VALUE, $error->code_);
            Assert::assertSame('CATALOG_VALUE: column 2: unsupported driver value', $error->getMessage());
            Assert::assertNull($error->getPrevious());
        }
    }

    /**
     * A driver value that the driver cannot decode is INT-172 and keeps the failure as its cause: a bytea stream whose
     * read fails.
     *
     * @param callable(CatalogPostgresTemporalPdo): Catalog $makeCatalog
     */
    public static function assertUndecodableDriverValue(callable $makeCatalog): void
    {
        if (!in_array(CatalogUnreadableStream::SCHEME, stream_get_wrappers(), true)) {
            stream_wrapper_register(CatalogUnreadableStream::SCHEME, CatalogUnreadableStream::class);
        }
        $stream = fopen(CatalogUnreadableStream::SCHEME . '://bytea', 'r');
        try {
            $makeCatalog(new CatalogPostgresTemporalPdo([['b', 'bytea']], [$stream]))
                ->tablePage(['namespace' => 'public', 'name' => 'temporal_probe'], 1, 0);
            Assert::fail('an unreadable bytea stream was read');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CATALOG_VALUE, $error->code_);
            Assert::assertSame('CATALOG_VALUE: the driver could not decode the value', $error->getMessage());
            Assert::assertInstanceOf(\RuntimeException::class, $error->getPrevious());
            Assert::assertSame(CatalogUnreadableStream::FAILURE, $error->getPrevious()->getMessage());
        }
    }

    /**
     * A read of a described table writes each temporal cell with exactly the fraction digits p of its native type, six
     * when the type names none, and fails with GRID_TEMPORAL_PRECISION when a non-zero digit lies beyond p.
     *
     * @param callable(CatalogPostgresTemporalPdo): Catalog $makeCatalog
     */
    public static function assertDeclaredPrecision(callable $makeCatalog): void
    {
        $table = ['namespace' => 'public', 'name' => 'temporal_probe'];
        $columns = [
            ['ts', 'timestamp(6) without time zone'],
            ['t', 'time(3) without time zone'],
            ['d', 'date'],
            ['t0', 'time without time zone'],
            ['ts0', 'timestamp(0) without time zone'],
        ];
        $page = $makeCatalog(new CatalogPostgresTemporalPdo(
            $columns,
            ['2026-06-01 00:00:00', '12:34:56.5', '2026-06-01', '12:34:56', '2026-06-01 01:02:03'],
        ))->tablePage($table, 1, 0);
        Assert::assertSame(
            [[1, '2026-06-01 00:00:00.000000', '12:34:56.500', '2026-06-01', '12:34:56.000000', '2026-06-01 01:02:03']],
            $page->result->rows,
        );

        try {
            $makeCatalog(new CatalogPostgresTemporalPdo(
                [['t', 'time(3) without time zone']],
                ['12:34:56.1234'],
            ))->tablePage($table, 1, 0);
            Assert::fail('a time with more fraction digits than its precision was read');
        } catch (OrmException $error) {
            Assert::assertSame(Code::GRID_TEMPORAL_PRECISION, $error->code_);
            Assert::assertSame(
                'GRID_TEMPORAL_PRECISION: column 2: temporal value has more fraction digits than its precision',
                $error->getMessage(),
            );
        }
    }
}
