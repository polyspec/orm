<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Bytes;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/** Shared collection-key and split-row identity cases for the PHP library and extension. */
trait CollectionIdentityCases
{
    /** @return array<string, mixed> */
    private static function sharedCollectionFixture(): array
    {
        $path = dirname(__DIR__, 3) . '/tests/collection/keys.json';
        $source = file_get_contents($path);
        self::assertIsString($source, "cannot read {$path}");
        return json_decode($source, true, 512, JSON_THROW_ON_ERROR);
    }

    /** @param array<string, mixed> $entry */
    private static function sharedCompositeValue(array $entry): mixed
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
        foreach (self::sharedCollectionFixture()['composites'] as $entry) {
            $row = array_map(self::sharedCompositeValue(...), $entry['values']);
            $refs = array_map(
                static fn (int $index): array => ['column' => "k{$index}", 'index' => $index],
                array_keys($row),
            );
            $dates = array_map(
                static fn (mixed $value): ?string => $value instanceof \DateTimeInterface
                    ? $value->format('c.u')
                    : null,
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
                self::assertNotSame($otherIdentity, $identity, "keys {$other} and {$entry['name']} collide");
            }
            $seen[$entry['name']] = $identity;
        }
    }

    public function testCompositeDateTimeMicrosecondsTrimTrailingZeroes(): void
    {
        foreach (self::sharedCollectionFixture()['datetime_microseconds'] as $entry) {
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
        $row = array_map(self::sharedCompositeValue(...), self::sharedCollectionFixture()['nullable_composite']);
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
        $compositeRefs = [
            ['column' => 'tenant_id', 'index' => 0],
            ['column' => 'enabled', 'index' => 1],
            ['column' => 'label', 'index' => 2],
        ];
        try {
            $splitRowSlot->invoke(null, [0, null, ''], $compositeRefs);
            self::fail('split root merge accepted SQL NULL in a composite identity');
        } catch (OrmException $error) {
            self::assertSame(Code::CODEC_DECODE, $error->code_);
            self::assertSame('CODEC_DECODE: split query row identity contains SQL NULL', $error->getMessage());
        }
        self::assertNotSame(
            $splitRowSlot->invoke(null, [0, false, ''], $compositeRefs),
            $splitRowSlot->invoke(null, [0, true, ''], $compositeRefs),
        );
    }
}

/** Shared weak and strict collection-key coercion behavior for the PHP library and extension. */
trait CollectionWeakTypedKeyCases
{
    public function testWeakAndStrictTypedKeyCoercionBoundaries(): void
    {
        $collection = new Collection();
        $model = new class extends Model {
            public static function meta(): array
            {
                return [];
            }
        };
        collectionWeakPut($collection, 2.0, $model);
        self::assertTrue($collection->has(2));

        $deprecations = [];
        set_error_handler(static function (int $severity, string $message) use (&$deprecations): bool {
            if ($severity === E_DEPRECATED) {
                $deprecations[] = $message;
                return true;
            }
            return false;
        });
        try {
            collectionWeakPut($collection, 3.5, $model);
        } finally {
            restore_error_handler();
        }
        self::assertTrue($collection->has(3));
        self::assertCount(1, $deprecations);
        self::assertStringContainsString(
            'Implicit conversion from float 3.5 to int loses precision',
            $deprecations[0],
        );

        $stringable = new class implements \Stringable {
            public function __toString(): string
            {
                return 'weak-stringable';
            }
        };
        collectionWeakPut($collection, $stringable, $model);
        self::assertSame('weak-stringable', $collection->keys()[2]);

        try {
            collectionWeakPut($collection, null, $model);
            self::fail('weak callers cannot pass a null collection key');
        } catch (\TypeError) {
            self::assertCount(3, $collection);
        }

        try {
            $collection->put(3.5, $model);
            self::fail('strict callers cannot pass a float collection key');
        } catch (\TypeError) {
            self::assertCount(3, $collection);
        }

        try {
            $collection->put($stringable, $model);
            self::fail('strict callers cannot coerce a Stringable collection key');
        } catch (\TypeError) {
            self::assertCount(3, $collection);
        }
    }
}
