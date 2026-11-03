<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Collection;
use Polyspec\Orm\Model;

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
