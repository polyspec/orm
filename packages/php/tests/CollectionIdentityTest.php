<?php

// The collection key identity of tests/collection/keys.json: every value type has its own key, and a NULL key is
// CODEC_DECODE.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/CollectionIdentityTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Collection;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

require_once __DIR__ . '/collection-weak-caller.php';

#[Small]
final class CollectionIdentityTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function fixture(): array
    {
        $src = file_get_contents(__DIR__ . '/../../../tests/collection/keys.json');
        self::assertIsString(
            $src,
            'tests/collection/keys.json is unreadable; run make orm-check from the checkout root'
        );
        $fixture = json_decode($src, true, 512, JSON_THROW_ON_ERROR);
        self::assertIsArray($fixture);
        return $fixture;
    }

    /** The PHP value of one fixture entry, with the type that the client reads from a column. */
    private static function valueOf(array $entry): mixed
    {
        return match ($entry['type']) {
            'text' => $entry['value'],
            'bool' => $entry['value'],
            'int' => $entry['value'],
            'bytes' => new Bytes(hex2bin($entry['hex'])),
            'datetime' => new \DateTime($entry['value']),
            default => self::fail("fixture {$entry['name']} has unknown type {$entry['type']}"),
        };
    }

    /** The PHP value of a composite key component. */
    private static function compositeValueOf(array $entry): mixed
    {
        return match ($entry['type']) {
            'text', 'bool', 'int' => $entry['value'],
            'bytes' => new Bytes(hex2bin($entry['hex'])),
            'datetime' => new \DateTimeImmutable($entry['value']),
            'null' => null,
            default => self::fail("unknown composite component type {$entry['type']}"),
        };
    }

    // Requirements: PRT-35.
    public function testEveryFixtureKeyHasItsOwnStableIdentity(): void
    {
        $seen = [];
        foreach (self::fixture()['keys'] as $entry) {
            $identity = Collection::identityOf(self::valueOf($entry));
            self::assertSame(
                $identity,
                Collection::identityOf(self::valueOf($entry)),
                "key {$entry['name']} has no stable identity"
            );
            if (isset($entry['same_as'])) {
                self::assertSame(
                    $seen[$entry['same_as']],
                    $identity,
                    "key {$entry['name']} differs from {$entry['same_as']}"
                );
                continue;
            }
            foreach ($seen as $other => $otherIdentity) {
                self::assertNotSame(
                    $otherIdentity,
                    $identity,
                    "keys $other and {$entry['name']} have the same identity"
                );
            }
            $seen[$entry['name']] = $identity;
        }
    }

    public function testToArrayPreservesCollectionModelOrder(): void
    {
        $first = new class extends Model {
            public static function meta(): array
            {
                return ['entity' => 'first'];
            }

            public function toArray(): array
            {
                return ['entity' => 'first'];
            }
        };
        $second = new class extends Model {
            public static function meta(): array
            {
                return ['entity' => 'second'];
            }

            public function toArray(): array
            {
                return ['entity' => 'second'];
            }
        };
        $collection = new Collection();
        $collection->put('first', $first);
        $collection->put('second', $second);

        self::assertSame([['entity' => 'first'], ['entity' => 'second']], $collection->toArray());
    }

    // Requirements: PRT-35.
    public function testANullKeyIsCodecDecode(): void
    {
        $expected = self::fixture()['null'];
        try {
            Collection::keyOf(null);
            self::fail('a NULL collection key was accepted');
        } catch (OrmException $e) {
            self::assertSame($expected['code'], $e->code_);
            self::assertSame($expected['code'] . ': ' . $expected['message'], $e->getMessage());
        }
    }

    public function testCompositeComponentsPreserveTypedIdentityAndSharedEncoding(): void
    {
        $seen = [];
        foreach (self::fixture()['composites'] as $entry) {
            $row = array_map(self::compositeValueOf(...), $entry['values']);
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
        foreach (self::fixture()['datetime_microseconds'] as $entry) {
            $date = new \DateTime($entry['value']);
            $before = $date->format('c.u');
            $row = [$date, ''];
            $refs = [
                ['column' => 'date', 'index' => 0],
                ['column' => 'text', 'index' => 1],
            ];
            $key = Db::rowKey($row, $refs);
            self::assertSame($entry['encoded'], $key, $entry['name']);
            self::assertSame($key, Db::rowKey($row, $refs), "{$entry['name']} changed on repeated creation");
            self::assertSame($before, $date->format('c.u'), "{$entry['name']} mutated its datetime input");
        }
    }

    public function testNullCompositeRowHasNoCollectionKey(): void
    {
        $row = array_map(self::compositeValueOf(...), self::fixture()['nullable_composite']);
        $refs = [['column' => 'first', 'index' => 0], ['column' => 'second', 'index' => 1]];
        self::assertNull(Db::rowKey($row, $refs));
    }

    // Requirements: T182-6-12.
    public function testWeakTypedKeyCallsFollowTheRuntimeUnionCoercionRules(): void
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
        self::assertStringContainsString('Implicit conversion from float 3.5 to int loses precision', $deprecations[0]);

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
