<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Collection;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\OrmException;

#[Small]
final class GroupRowsTest extends TestCase
{
    // Requirements: INT-68, PRT-69, INT-1, INT-90. The imported cases assert the public group-row output values.
    use GroupRowsCases;

    // Requirements: INT-68, INT-69, INT-70, INT-71.
    public function testOwner(): void
    {
        foreach ([Collection::class, GroupRows::class] as $class) {
            $method = new \ReflectionMethod($class, 'toArray');
            self::assertTrue($method->isPublic(), "$class::toArray is not public");
            self::assertSame([], $method->getParameters(), "$class::toArray accepts arguments");
            self::assertSame('array', $method->getReturnType()?->getName(), "$class::toArray return type changed");
            self::assertSame(
                $class,
                $method->getDeclaringClass()->getName(),
                "$class::toArray is not declared on the class"
            );
        }
        $row = new GroupRow([['is_close', false], ['row_count', 3]]);
        self::assertSame(3, $row->count());
        self::assertFalse($row->value('is_close'));
        $nullable = new GroupRow([['price', null], ['row_count', 0]]);
        self::assertNull($nullable->value('price'));
        try {
            $row->value('name');
            self::fail('an unselected group value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNSELECTED, $error->code_);
        }
        self::assertSame(['is_close' => false, 'row_count' => 3], $row->toArray());
        $second = new GroupRow([['is_close', true], ['row_count', 2]]);
        $rows = new GroupRows([$row, $second]);
        self::assertCount(2, $rows);
        self::assertSame([
            ['is_close' => false, 'row_count' => 3],
            ['is_close' => true, 'row_count' => 2],
        ], $rows->toArray());
    }
}
