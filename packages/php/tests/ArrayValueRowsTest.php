<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Collection;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\Model;

#[Small]
final class ArrayValueRowsTest extends TestCase
{
    public function testRowsKeepsInputOrder(): void
    {
        $first = new class extends Model {
            public static function meta(): array
            {
                return ['entity' => 'first'];
            }

            public function toArray(): array
            {
                return ['name' => 'first'];
            }
        };
        $second = new class extends Model {
            public static function meta(): array
            {
                return ['entity' => 'second'];
            }

            public function toArray(): array
            {
                return ['name' => 'second'];
            }
        };

        $collection = new Collection();
        $collection->put('first', $first);
        $collection->put('second', $second);
        self::assertSame([['name' => 'first'], ['name' => 'second']], $collection->toArray());

        $groupRows = new GroupRows([
            new GroupRow([['name', 'first'], ['row_count', 1]]),
            new GroupRow([['name', 'second'], ['row_count', 1]]),
        ]);
        self::assertSame(
            [['name' => 'first', 'row_count' => 1], ['name' => 'second', 'row_count' => 1]],
            $groupRows->toArray()
        );
    }
}
