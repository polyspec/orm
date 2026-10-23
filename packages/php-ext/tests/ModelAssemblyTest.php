<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Assembly;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Frame;
use Polyspec\Orm\GroupRow;
use Polyspec\Orm\GroupRows;
use Polyspec\Orm\MarkdownLinks;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

final class ModelAssemblyFixture extends Model
{
    public static function meta(): array
    {
        return ['entity' => 'model_assembly_fixture'];
    }
}

#[Small]
final class ModelAssemblyTest extends TestCase
{
    public function testFrameOwnsTheNativeJoinMapAndOuterPath(): void
    {
        $root = new ModelAssemblyFixture();
        $child = new ModelAssemblyFixture();
        $outer = new ModelAssemblyFixture();
        $frame = new Frame($root, $outer);
        $frame->add($child, 'child', $root);

        self::assertTrue((new \ReflectionClass(Frame::class))->isInternal());
        self::assertSame('', $frame->path($root));
        self::assertFalse($frame->joined($root));
        self::assertTrue($frame->joined($child));
        self::assertSame($root, $frame->parentOf($child));
        self::assertNull($frame->parentOf($root));
        self::assertSame('child', $frame->pathOf($child));
        self::assertSame('^', $frame->pathOf($outer));
        self::assertTrue($frame->place($child));
        self::assertFalse($frame->place($child));

        try {
            $frame->pathOf(new ModelAssemblyFixture());
            self::fail('a model outside the statement was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
            self::assertSame('CONFIG: model_assembly_fixture is not part of the statement', $error->getMessage());
        }
    }

    public function testGroupRowPreservesTypedValuesAndChecksTheRowCountExactly(): void
    {
        $row = new GroupRow([
            ['active', false],
            ['optional', null],
            ['large', '9223372036854775807'],
            ['row_count', '3'],
        ]);

        self::assertTrue((new \ReflectionClass(GroupRow::class))->isInternal());
        self::assertTrue((new \ReflectionClass(GroupRow::class))->isReadOnly());
        self::assertSame(3, $row->count());
        self::assertSame(false, $row->value('active'));
        self::assertNull($row->value('optional'));
        self::assertSame('9223372036854775807', $row->value('large'));
        self::assertSame(3, $row->toArray()['row_count']);
        self::assertSame($row->toArray(), $row->jsonSerialize());
        self::assertSame($row->toArray(), (clone $row)->toArray());
        self::assertSame($row->toArray(), unserialize(serialize($row))->toArray());

        try {
            $row->value('missing');
            self::fail('an unselected group value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::COLUMN_UNSELECTED, $error->code_);
            self::assertSame('COLUMN_UNSELECTED: group column missing was not selected', $error->getMessage());
        }

        foreach (
            [
                [[['name', 'value']]],
                [[['row_count', 1], ['row_count', 2]]],
                [[['', 'value'], ['row_count', 1]]],
            ] as $entries
        ) {
            try {
                new GroupRow($entries[0]);
                self::fail('malformed group entries were accepted');
            } catch (OrmException $error) {
                self::assertContains($error->code_, [Code::CONFIG, Code::INTERNAL]);
            }
        }

        foreach ([true, -1, '-1', '00', '9223372036854775808', 1.5] as $invalid) {
            try {
                new GroupRow([['row_count', $invalid]]);
                self::fail('an invalid row_count was accepted');
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
                self::assertContains($error->getMessage(), [
                    'CODEC_DECODE: group result row_count is negative',
                    'CODEC_DECODE: group result row_count is not an exact integer',
                ]);
            }
        }
    }

    public function testGroupRowsUseAKeyPreservingSnapshotIterator(): void
    {
        $first = new GroupRow([['name', 'one'], ['row_count', 1]]);
        $second = new GroupRow([['name', 'two'], ['row_count', 2]]);
        $rows = new GroupRows(['first' => $first, 9 => $second]);
        $iterator = $rows->getIterator();

        self::assertTrue((new \ReflectionClass(GroupRows::class))->isInternal());
        self::assertTrue((new \ReflectionClass(GroupRows::class))->isReadOnly());
        self::assertTrue((new \ReflectionClass($iterator))->isInternal());
        self::assertSame(2, count($rows));
        self::assertSame(['first' => $first, 9 => $second], $rows->all());
        self::assertSame([
            'first' => ['name' => 'one', 'row_count' => 1],
            9 => ['name' => 'two', 'row_count' => 2],
        ], $rows->toArray());

        $visited = [];
        foreach ($iterator as $key => $row) {
            $visited[$key] = $row;
        }
        self::assertSame(['first' => $first, 9 => $second], $visited);
        self::assertSame($rows->toArray(), $rows->jsonSerialize());
        self::assertSame($rows->toArray(), (clone $rows)->toArray());
        try {
            clone $iterator;
            self::fail('the generator-backed iterator was cloneable');
        } catch (\Error) {
        }
        try {
            serialize($iterator);
            self::fail('the generator-backed iterator was serializable');
        } catch (\Exception) {
        }
        self::assertSame($rows->toArray(), unserialize(serialize($rows))->toArray());

        try {
            foreach ($rows as &$row) {
                unset($row);
            }
            self::fail('group rows allowed iteration by reference');
        } catch (\Error $error) {
            self::assertStringContainsString('by reference', $error->getMessage());
        }

        try {
            new GroupRows([new \stdClass()]);
            self::fail('a non-GroupRow value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::CONFIG, $error->code_);
            self::assertSame('CONFIG: group result contains an invalid row', $error->getMessage());
        }
    }

    public function testGroupResultObjectsAreCollectedThroughTheirValues(): void
    {
        $holder = new \stdClass();
        $row = new GroupRow([['holder', $holder], ['row_count', 0]]);
        $holder->row = $row;
        $rows = new GroupRows([$row]);
        $weakRows = \WeakReference::create($rows);
        $weakRow = \WeakReference::create($row);

        unset($rows, $row, $holder);
        gc_collect_cycles();

        self::assertNull($weakRows->get());
        self::assertNull($weakRow->get());
    }


    public function testGroupRowsIteratorParticipatesInCycleCollection(): void
    {
        $holder = new \stdClass();
        $row = new GroupRow([['holder', $holder], ['row_count', 0]]);
        $rows = new GroupRows([$row]);
        $iterator = $rows->getIterator();
        $holder->iterator = $iterator;
        $weakRows = \WeakReference::create($rows);
        $weakRow = \WeakReference::create($row);
        $weakIterator = \WeakReference::create($iterator);

        unset($rows, $row, $iterator, $holder);
        gc_collect_cycles();

        self::assertNull($weakRows->get());
        self::assertNull($weakRow->get());
        self::assertNull($weakIterator->get());
    }

    public function testAssemblyRoutesSqlAndMarkdownRowsWithTypedKeys(): void
    {
        $db = new Db(null, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $rowA = ['value' => 'A'];
        $rowB = ['value' => 'B'];
        $parent = [7, null];
        $refs = [['column' => 'id', 'index' => 0]];
        $slot = Db::rowSlot($parent, $refs);
        self::assertIsString($slot);
        $result = [
            'params' => [],
            'steps' => [2 => [
                'step' => ['assemble' => ['node' => 'child']],
                'byKey' => [$slot => [0, 1]],
                'data' => [$rowA, $rowB],
            ]],
        ];
        $assembly = new Assembly($db, null, $result);
        $child = ['step' => 2, 'parent_keys' => $refs, 'assemble' => ['node' => 'markdown-child'], 'rel' => 'child'];

        self::assertSame(['node' => 'child'], $assembly->relationAssemble($child));
        self::assertSame([$rowA, $rowB], $assembly->related($child, $parent));
        self::assertSame($parent, $assembly->joinRow(['assemble' => ['columns' => [['index' => 0]]]], $parent));
        self::assertNull($assembly->joinRow(['assemble' => ['columns' => [['index' => 1]]]], $parent));

        $links = new MarkdownLinks();
        $links->joins['child'] = [4];
        $links->rels['child'] = [[5]];
        $markdown = new Assembly($db, null, ['markdown' => true]);
        self::assertSame(['node' => 'markdown-child'], $markdown->relationAssemble($child));
        self::assertSame([4], $markdown->joinRow($child, [$links]));
        self::assertSame([[5]], $markdown->related($child, [$links]));
        self::assertSame('UTC', $assembly->zone->getName());
    }
}
