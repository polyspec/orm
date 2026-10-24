<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Assembly;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Collection;
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
    private static function collectionFixture(): array
    {
        $path = __DIR__ . '/../../../tests/collection/keys.json';
        $source = file_get_contents($path);
        self::assertIsString($source, "cannot read $path");
        return json_decode($source, true, 512, JSON_THROW_ON_ERROR);
    }

    private static function compositeValue(array $entry): mixed
    {
        return match ($entry['type']) {
            'text', 'bool', 'int' => $entry['value'],
            'bytes' => new Bytes(hex2bin($entry['hex'])),
            'datetime' => new \DateTime($entry['value']),
            'null' => null,
            default => self::fail("unknown composite component type {$entry['type']}"),
        };
    }

    public function testCompositeComponentsPreserveTypedIdentityAndSharedEncoding(): void
    {
        $seen = [];
        foreach (self::collectionFixture()['composites'] as $entry) {
            $row = array_map(self::compositeValue(...), $entry['values']);
            $refs = array_map(
                static fn(int $index): array => ['column' => "k$index", 'index' => $index],
                array_keys($row),
            );
            $dates = array_map(
                static fn(mixed $value): ?string => $value instanceof \DateTimeInterface ? $value->format('c.u') : null,
                $row,
            );
            $key = Db::rowKey($row, $refs);
            self::assertSame($entry['encoded'], $key, $entry['name']);
            self::assertSame($key, Db::rowKey($row, $refs), "{$entry['name']} changed on repeated creation");
            foreach ($row as $index => $value) {
                if ($dates[$index] !== null) {
                    self::assertSame(
                        $dates[$index],
                        $value->format('c.u'),
                        "{$entry['name']} mutated its datetime input",
                    );
                }
            }
            $identity = Collection::identityOf($key);
            if (isset($entry['same_as'])) {
                self::assertSame($seen[$entry['same_as']], $identity, $entry['name']);
                continue;
            }
            foreach ($seen as $other => $otherIdentity) {
                self::assertNotSame($otherIdentity, $identity, "keys $other and {$entry['name']} collide");
            }
            $seen[$entry['name']] = $identity;
        }
    }

    public function testCompositeDateTimeMicrosecondsTrimTrailingZeroes(): void
    {
        foreach (self::collectionFixture()['datetime_microseconds'] as $entry) {
            $date = new \DateTime($entry['value']);
            $before = $date->format('c.u');
            $row = [$date, ''];
            $refs = [['column' => 'date', 'index' => 0], ['column' => 'text', 'index' => 1]];
            $key = Db::rowKey($row, $refs);
            self::assertSame($entry['encoded'], $key, $entry['name']);
            self::assertSame($key, Db::rowKey($row, $refs), "{$entry['name']} changed on repeated creation");
            self::assertSame($before, $date->format('c.u'), "{$entry['name']} mutated its datetime input");
        }
    }

    public function testNullCompositeRowHasNoCollectionKey(): void
    {
        $row = array_map(self::compositeValue(...), self::collectionFixture()['nullable_composite']);
        $refs = [['column' => 'first', 'index' => 0], ['column' => 'second', 'index' => 1]];
        self::assertNull(Db::rowKey($row, $refs));
    }

    public function testSplitRootMergeRejectsSqlNullIdentity(): void
    {
        $refs = [['column' => 'id', 'index' => 0]];
        $splitRowSlot = new \ReflectionMethod(Db::class, 'splitRowSlot');
        try {
            $splitRowSlot->invoke(null, [null], $refs);
            self::fail('split root merge accepted SQL NULL identity');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: split query row identity contains SQL NULL', $error->getMessage());
        }
        self::assertNotSame($splitRowSlot->invoke(null, [0], $refs), $splitRowSlot->invoke(null, [''], $refs));
        self::assertNotSame($splitRowSlot->invoke(null, [false], $refs), $splitRowSlot->invoke(null, [0], $refs));
        $compositeRefs = [['column' => 'tenant_id', 'index' => 0], ['column' => 'enabled', 'index' => 1], ['column' => 'label', 'index' => 2]];
        try {
            $splitRowSlot->invoke(null, [0, null, ''], $compositeRefs);
            self::fail('split root merge accepted SQL NULL in a composite identity');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: split query row identity contains SQL NULL', $error->getMessage());
        }
        self::assertNotSame($splitRowSlot->invoke(null, [0, false, ''], $compositeRefs), $splitRowSlot->invoke(null, [0, true, ''], $compositeRefs));
    }

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

    // PRT-36: exercise the extension's native Model::groupValue method.
    public function testGroupValueRejectsInvalidStoredBoolean(): void
    {
        $groupValue = new \ReflectionMethod(Model::class, 'groupValue');
        self::assertTrue($groupValue->isInternal(), 'the test did not reach the extension method');
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        try {
            $groupValue->invoke(
                new ModelAssemblyFixture(),
                $db,
                ['name' => 'active', 'column' => '', 'type' => 'bool'],
                'invalid',
            );
            self::fail('invalid boolean group value was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: group column active is not boolean', $error->getMessage());
        }
    }

    public function testGroupValuePreservesExactI64(): void
    {
        $groupValue = new \ReflectionMethod(Model::class, 'groupValue');
        self::assertTrue($groupValue->isInternal(), 'the test did not reach the extension method');
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        $want = 9007199254740991;
        $value = $groupValue->invoke(
            new ModelAssemblyFixture(),
            $db,
            ['name' => 'exact_value', 'column' => '', 'type' => 'i64'],
            $want,
        );
        self::assertSame($want, $value);
        $row = new GroupRow([['exact_value', $value], ['row_count', 1]]);
        self::assertSame($want, $row->value('exact_value'));
        self::assertSame(['exact_value' => $want, 'row_count' => 1], $row->toArray());
    }

    public function testGroupRowCountEnforcesExactness(): void
    {
        self::assertTrue((new \ReflectionClass(GroupRow::class))->isInternal());
        foreach ([true, 1.5, -1, 9007199254740992, 9007199254740992.0, '9007199254740992'] as $invalid) {
            try {
                new GroupRow([['row_count', $invalid]]);
                self::fail('invalid row_count was accepted: ' . var_export($invalid, true));
            } catch (OrmException $error) {
                self::assertSame(Code::CODEC_DECODE, $error->code_);
            }
        }
        try {
            new GroupRow([['selected', 'x']]);
            self::fail('missing row_count was accepted');
        } catch (OrmException $error) {
            self::assertSame(Code::INTERNAL, $error->code_);
        }
        $validCounts = [[0, 0], ['0', 0], [9007199254740991, 9007199254740991], ['9007199254740991', 9007199254740991]];
        foreach ($validCounts as [$input, $want]) {
            $row = new GroupRow([['row_count', $input]]);
            self::assertSame($want, $row->count());
            self::assertSame($want, $row->toArray()['row_count']);
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
