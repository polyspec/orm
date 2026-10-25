<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Engine;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\Model;
use Polyspec\Orm\Planner;
use Polyspec\Orm\Tests\Model\Author;
use ReflectionClass;

#[Medium]
final class GroupRowsDbNativeTest extends TestCase
{
    use DatabaseTestAssertions;

    public static function setUpBeforeClass(): void
    {
        foreach ([Engine::class, Model::class, Planner::class, GroupRow::class, GroupRows::class] as $class) {
            Assert::assertTrue((new ReflectionClass($class))->isInternal(), "$class must use the native extension");
        }
        Assert::assertTrue(is_subclass_of(Author::class, Model::class));
    }

    // Requirements: INT-31.
    public function testGroupRows(): void
    {
        $this->forEachBenchDatabase(static function (Db $db): void {
            $query = static fn(): Author => (new Author())($db);
            $groups = $query()->groupByIsClose()->orderByIsCloseAsc()->getsCount();
            Assert::assertTrue(
                $groups instanceof GroupRows && count($groups) === 2,
                'getsCount returned partial models'
            );
            $total = 0;
            foreach ($groups as $row) {
                Assert::assertTrue(
                    $row instanceof GroupRow && is_bool($row->value('is_close')) && $row->count() >= 1,
                    'grouped boolean or count has the wrong type'
                );
                Assert::assertIsInt($row->count(), 'group count changed type');
                Assert::assertSame(
                    ['is_close', 'row_count'],
                    array_keys($row->toArray()),
                    'group row includes an unselected field'
                );
                self::assertColumnUnselected(static fn() => $row->value('name'), 'name');
                $total += $row->count();
            }
            Assert::assertSame($query()->getCount(), $total, 'group counts do not sum to the row count');
            $services = $query()->groupByServiceSeq()->getsCount();
            $serviceTotal = 0;
            foreach ($services as $row) {
                Assert::assertIsInt($row->value('service_seq'), 'grouped integer changed type');
                $serviceTotal += $row->count();
            }
            Assert::assertSame($total, $serviceTotal, 'service group counts differ');
            $nullable = $query()->groupByPrice()->getsCount();
            $nullableTotal = 0;
            $sawNull = false;
            foreach ($nullable as $row) {
                if ($row->value('price') === null) {
                    $sawNull = true;
                }
                $nullableTotal += $row->count();
            }
            Assert::assertTrue($sawNull && $nullableTotal === $total, 'SQL NULL group value was lost');
        });
    }
}
