<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Collection;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;

#[Small]
final class GroupRowsTest extends TestCase
{
    // Requirements: PRT-69. The imported exact-i64 and row-count cases assert the public group-row output values.
    use GroupRowsCases;

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
        self::assertSame(['is_close' => false, 'row_count' => 3], $row->toArray());
        $rows = new GroupRows([$row]);
        self::assertCount(1, $rows);
        self::assertSame([['is_close' => false, 'row_count' => 3]], $rows->toArray());
    }
}
