<?php

// Row keys that match relation children to parents and key collections.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/RelationKeysTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Db;
use Polyspec\Orm\Frame;
use Polyspec\Orm\Model;
use Polyspec\Orm\Request;
use Polyspec\Orm\Tests\Model\Author;

#[Small]
final class RelationKeysTest extends TestCase
{
    public function testParentSlotExpansionPadsCompositeKeysAndRenumbersFollowingPlaceholders(): void
    {
        $expand = new \ReflectionMethod(Db::class, 'expandIn');
        $single = [
            'sql' => 'SELECT $1 WHERE id IN ($2) AND active = $3',
            'bind_slots' => [['from' => 'param'], ['from' => 'parent'], ['from' => 'param']],
            'parent' => ['keys' => [['column' => 'id', 'index' => 0]]],
        ];
        [$singleSql, $singleValues] = $expand->invoke(null, $single, [7]);
        self::assertSame('SELECT $1 WHERE id IN ($2) AND active = $3', $singleSql);
        self::assertSame([7], $singleValues);

        $composite = [
            'sql' => 'SELECT $1 WHERE (a, b) IN (($2)) AND active = $3',
            'bind_slots' => [['from' => 'param'], ['from' => 'parent'], ['from' => 'param']],
            'parent' => ['keys' => [['column' => 'a', 'index' => 0], ['column' => 'b', 'index' => 1]]],
        ];
        [$numberedSql, $numberedValues] = $expand->invoke(null, $composite, [10, 11, 20, 21, 30, 31]);
        self::assertSame(
            'SELECT $1 WHERE (a, b) IN (($2, $3), ($4, $5), ($6, $7), ($8, $9)) AND active = $10',
            $numberedSql,
        );
        self::assertSame([10, 11, 20, 21, 30, 31, 30, 31], $numberedValues);

        $composite['sql'] = 'SELECT ? WHERE (a, b) IN ((?)) AND active = ?';
        [$positionalSql, $positionalValues] = $expand->invoke(null, $composite, [10, 11, 20, 21, 30, 31]);
        self::assertSame('SELECT ? WHERE (a, b) IN ((?, ?), (?, ?), (?, ?), (?, ?)) AND active = ?', $positionalSql);
        self::assertSame([10, 11, 20, 21, 30, 31, 30, 31], $positionalValues);
    }

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

    // Requirements: PRT-40.
    public function testTuplePredicatePadsByRepeatingTheLastRow(): void
    {
        $model = new Author();
        $request = new Request('all', 'sha256:tuple-padding');
        $predicate = (new \ReflectionMethod(Model::class, 'predIr'))->invoke($model, [
            'kind' => 'tuple',
            'column' => '',
            'op' => 'tuple_in',
            'cols' => ['tenant_id', 'account_id'],
            'value' => [[10, 1], [10, 2], [10, 3]],
        ], $request, new Frame($model, null));

        self::assertSame(range(0, 7), $predicate['ps']);
        self::assertSame([10, 1, 10, 2, 10, 3, 10, 3], $request->params);
    }

}
