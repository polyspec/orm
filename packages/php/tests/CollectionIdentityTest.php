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
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Model;
use Polyspec\Orm\OrmException;

#[Small]
final class CollectionIdentityTest extends TestCase
{
    // Requirements: PRT-35.
    use CollectionIdentityCases;
    use CollectionWeakTypedKeyCases;

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

    // Requirements: INT-11, INT-63, PRT-35.
    public function testEveryFixtureKeyHasItsOwnStableIdentity(): void
    {
        $seen = [];
        $collection = new Collection();
        $model = new class extends Model {
            public static function meta(): array
            {
                return [];
            }
        };
        $expectedKeys = [];
        foreach (self::fixture()['keys'] as $entry) {
            $value = self::valueOf($entry);
            $identity = Collection::identityOf($value);
            self::assertSame(
                $identity,
                Collection::identityOf($value),
                "key {$entry['name']} has no stable identity"
            );
            self::assertSame($value, Collection::keyOf($value), "key {$entry['name']} changed its native type");
            if (isset($entry['same_as'])) {
                self::assertSame(
                    $seen[$entry['same_as']],
                    $identity,
                    "key {$entry['name']} differs from {$entry['same_as']}"
                );
                continue;
            }
            $collection->put($value, $model);
            $expectedKeys[] = $value;
            foreach ($seen as $other => $otherIdentity) {
                self::assertNotSame(
                    $otherIdentity,
                    $identity,
                    "keys $other and {$entry['name']} have the same identity"
                );
            }
            $seen[$entry['name']] = $identity;
        }
        self::assertSame($expectedKeys, $collection->keys());
        foreach ($expectedKeys as $key) {
            self::assertSame($model, $collection->get($key));
        }
    }

    // Requirements: INT-80, INT-86.
    public function testGetAndFetchedValueUseTheTypedKey(): void
    {
        $integer = new class ('integer') extends Model {
            public function __construct(public string $label)
            {
            }
            public static function meta(): array
            {
                return [];
            }
        };
        $text = new class ('text') extends Model {
            public function __construct(public string $label)
            {
            }
            public static function meta(): array
            {
                return [];
            }
        };
        self::assertTypedKeyGetAndFetch($integer, $text);
    }

    // Requirements: INT-62, PLN-6, INT-81, INT-82, INT-83, INT-84, INT-85.
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

        self::assertCount(2, $collection);
        self::assertSame($first, $collection->first());
        self::assertSame($first, $collection->get('first'));
        self::assertSame($second, $collection->get('second'));
        self::assertSame(['first', 'second'], $collection->keys());
        self::assertSame([$first, $second], $collection->all());
        self::assertSame([['first', $first], ['second', $second]], $collection->entries());
        self::assertSame([['entity' => 'first'], ['entity' => 'second']], $collection->toArray());
        $db = new Db(null, 'mysql', new Config(), new \DateTimeZone('UTC'));
        self::assertSame($collection, $collection->connect($db));
        self::assertSame($db, $first->connection());
        self::assertSame($db, $second->connection());
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
}
