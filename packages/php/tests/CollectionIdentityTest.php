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
class CollectionIdentityTest extends TestCase
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
}
