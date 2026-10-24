<?php

// Row keys that match relation children to parents and key collections.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RelationKeysTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Tests\Model\Author;

#[Small]
final class RelationKeysTest extends TestCase
{
    public function testRelationKeys(): void
    {
        $refs = [['column' => 'tenant_id', 'index' => 0], ['column' => 'account_id', 'index' => 1]];
        $first = Db::rowKey(['1', '23'], $refs);
        $second = Db::rowKey(['12', '3'], $refs);
        self::assertIsString($first);
        self::assertIsString($second);
        self::assertNotSame($first, $second, 'composite row keys collide');
        self::assertNull(Db::rowKey([1, null], $refs), 'null composite row key was accepted');
        self::assertSame(7, Db::rowKey([7], [['column' => 'id', 'index' => 0]]), 'single integer key type changed');
        $splitRowSlot = new \ReflectionMethod(Db::class, 'splitRowSlot');
        try {
            $splitRowSlot->invoke(null, [null], [['column' => 'id', 'index' => 0]]);
            self::fail('split root merge accepted SQL NULL identity');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: split query row identity contains SQL NULL', $error->getMessage());
        }
        self::assertNotSame(
            $splitRowSlot->invoke(null, [0], [['column' => 'id', 'index' => 0]]),
            $splitRowSlot->invoke(null, [''], [['column' => 'id', 'index' => 0]])
        );
        self::assertNotSame(
            $splitRowSlot->invoke(null, [false], [['column' => 'id', 'index' => 0]]),
            $splitRowSlot->invoke(null, [0], [['column' => 'id', 'index' => 0]])
        );
        foreach (['get', 'gets', 'getCount', 'getsPage', 'create', 'update', 'delete'] as $method) {
            self::assertTrue(method_exists(Author::class, $method), "terminal $method is missing");
        }
        foreach (
            [
            'one',
            'all',
            'count',
            'using',
            'begin',
            'commit',
            'rollback',
            'savepoint',
            'exec',
            'offsetGet'
            ] as $method
        ) {
            self::assertFalse(method_exists(Author::class, $method), "removed method $method remains public");
        }
    }
}
