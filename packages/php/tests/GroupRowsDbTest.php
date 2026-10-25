<?php

// Grouped counts on the seeded bench database of each dialect (BENCH_<DIALECT>_DSN, from make databases-create):
// getsCount returns group rows whose grouped values keep their types (boolean, integer, SQL NULL), that hold only the
// grouped columns and the count, and whose counts sum to the row count. The test only reads.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/GroupRowsDbTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\Tests\Model\Author;

#[Medium]
final class GroupRowsDbTest extends TestCase
{
    use DatabaseTestAssertions;

    // Requirements: INT-31.
    public function testGroupRows(): void
    {
        $this->forEachBenchDatabase(static function (Db $db): void {
            $query = static fn(): Author => (new Author())($db);
            $groups = $query()->groupByIsClose()->orderByIsCloseAsc()->getsCount();
            self::assertTrue(
                $groups instanceof GroupRows && count($groups) === 2,
                'getsCount returned partial models'
            );
            $total = 0;
            foreach ($groups as $row) {
                self::assertTrue(
                    $row instanceof GroupRow && is_bool($row->value('is_close')) && $row->count() >= 1,
                    'grouped boolean or count has the wrong type'
                );
                self::assertSame(
                    ['is_close', 'row_count'],
                    array_keys($row->toArray()),
                    'group row includes an unselected field'
                );
                self::assertColumnUnselected(static fn() => $row->value('name'), 'name');
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
        });
    }
}
