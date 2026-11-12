<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use ReflectionMethod;

#[Small]
final class ParentSlotExpansionTest extends TestCase
{
    // Requirements: DSL-153.
    public function testBareDollarInLiteralIsPreserved(): void
    {
        $expand = new ReflectionMethod(Db::class, 'expandIn');
        [$sql, $values] = $expand->invoke(null, [
            'sql' => "SELECT '$' AS sign, id FROM items WHERE key IN ($1)",
            'bind_slots' => [['from' => 'parent']],
            'parent' => ['keys' => [['column' => 'key', 'index' => 0]]],
        ], [7]);

        self::assertSame("SELECT '$' AS sign, id FROM items WHERE key IN ($1)", $sql);
        self::assertSame([7], $values);
    }
}
