<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use Polyspec\Orm\Catalog;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;

/** The temporal cells of a described PostgreSQL table, shared by the library and the extension (INT-103, INT-117). */
final class CatalogPostgresTemporalCases
{
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
        }
    }
}
