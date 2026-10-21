<?php

// Grouped counts on the seeded bench database of each dialect (BENCH_<DIALECT>_DSN, from make databases-create): getsCount returns group rows whose grouped values keep their types
// (boolean, integer, SQL NULL), that hold only the grouped columns and the count, and whose counts sum to the row count.
// The test only reads.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/GroupRowsDbTest.php
declare(strict_types=1);

require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

#[Medium]
final class GroupRowsDbTest extends TestCase
{
    // Requirements: INT-31.
    public function test_group_rows(): void
    {
        foreach (['mysql' => 'BENCH_MYSQL_DSN', 'postgres' => 'BENCH_POSTGRES_DSN', 'sqlite' => 'BENCH_SQLITE_DSN'] as $driver => $variable) {
            $dsn = requiredDsn($variable);
            $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'));
            try {
                self::assertSame($driver, $db->driver(), 'DSN selected the wrong database');
                $query = static fn(): Author => (new Author())($db);
                $groups = $query()->groupByIsClose()->orderByIsCloseAsc()->getsCount();
                self::assertTrue($groups instanceof GroupRows && count($groups) === 2, 'getsCount returned partial models');
                $total = 0;
                foreach ($groups as $row) {
                    self::assertTrue($row instanceof GroupRow && is_bool($row->value('is_close')) && $row->count() >= 1, 'grouped boolean or count has the wrong type');
                    self::assertSame(['is_close', 'row_count'], array_keys($row->toArray()), 'group row includes an unselected field');
                    try {
                        $row->value('name');
                        self::fail('unselected model column was available');
                    } catch (OrmException $error) {
                        self::assertSame(Code::COLUMN_UNSELECTED, $error->code_, $error->getMessage());
                    }
                    $total += $row->count();
                }
                self::assertSame($query()->getCount(), $total, 'group counts do not sum to the row count');
                $services = $query()->groupByServiceSeq()->getsCount();
                $serviceTotal = 0;
                foreach ($services as $row) {
                    self::assertIsInt($row->value('service_seq'), 'grouped integer changed type');
                    $serviceTotal += $row->count();
                }
                self::assertSame($total, $serviceTotal, 'service group counts differ');
                $nullable = $query()->groupByPrice()->getsCount();
                $nullableTotal = 0;
                $sawNull = false;
                foreach ($nullable as $row) {
                    if ($row->value('price') === null) {
                        $sawNull = true;
                    }
                    $nullableTotal += $row->count();
                }
                self::assertTrue($sawNull && $nullableTotal === $total, 'SQL NULL group value was lost');
            } finally {
                $db->close();
            }
        }
    }
}
