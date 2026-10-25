<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use DateTimeZone;
use Pdo\Sqlite;
use Polyspec\Orm\Cancellation;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

#[Small]
final class QueryCancellationNativeTest extends TestCase
{
    use \Polyspec\Orm\Tests\QueryCancellationDbCases;

    public function testNativeCancellationStateIsPrivatePersistentAndRemovedWhenReleased(): void
    {
        self::assertTrue((new ReflectionMethod(Cancellation::class, 'cancel'))->isInternal());
        self::assertTrue((new ReflectionMethod(Db::class, 'withCancellation'))->isInternal());
        $cancellation = new Cancellation();
        $path = $cancellation->statePath();
        self::assertCancellationStateTransitions($cancellation, $path);

        $root = new Db(Sqlite::connect('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
        $bound = $root->withCancellation($cancellation);
        self::assertNotSame($root, $bound, 'withCancellation returns a derived Db handle');
        $root->close();
        unset($bound, $root);

        unset($cancellation);
        self::assertFileDoesNotExist($path);
    }

    public function testNativeCancellationDispatchesOnlyToActiveConnectionSlots(): void
    {
        $cancellation = new Cancellation();
        $firstRoot = new Db(Sqlite::connect('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
        $secondRoot = new Db(Sqlite::connect('sqlite::memory:'), 'sqlite', new Config(), new DateTimeZone('UTC'));
        $firstHandle = $firstRoot->withCancellation($cancellation);
        $secondHandle = $secondRoot->withCancellation($cancellation);
        $slotProperty = new \ReflectionProperty(Db::class, 'cancellationSlot');
        $firstDbSlot = $slotProperty->getValue($firstHandle);
        $secondDbSlot = $slotProperty->getValue($secondHandle);
        $firstCalls = 0;
        $secondCalls = 0;
        $inactiveCalls = 0;
        $firstSlot = $cancellation->registerCancelQuery(101, self::countingCancelQuery($firstCalls));
        $secondSlot = $cancellation->registerCancelQuery(202, self::countingCancelQuery($secondCalls));
        $inactiveSlot = $cancellation->registerCancelQuery(303, self::countingCancelQuery($inactiveCalls));

        self::assertNotSame($firstDbSlot, $secondDbSlot);
        self::assertSame([1, 2, 3, 4, 5], [$firstDbSlot, $secondDbSlot, $firstSlot, $secondSlot, $inactiveSlot]);
        $cancellation->begin($firstDbSlot);
        $cancellation->begin($secondDbSlot);
        $cancellation->begin($firstSlot);
        $cancellation->begin($secondSlot);
        self::assertSame("\1\1\1\1\1\0", file_get_contents($cancellation->statePath()));

        $cancellation->cancel();

        self::assertSame(1, $firstCalls);
        self::assertSame(1, $secondCalls);
        self::assertSame(0, $inactiveCalls);
        self::assertSame("\3\1\1\1\1\0", file_get_contents($cancellation->statePath()));
        $cancellation->end($firstDbSlot);
        $cancellation->end($firstSlot);
        self::assertSame("\3\0\1\0\1\0", file_get_contents($cancellation->statePath()));
        $cancellation->end($secondDbSlot);
        $cancellation->end($secondSlot);
        self::assertSame("\2\0\0\0\0\0", file_get_contents($cancellation->statePath()));
        $firstRoot->close();
        $secondRoot->close();
    }

    // Requirements: CFG-9.
    public function testNativeCancellationInterruptsSqliteRollsBackAndKeepsRootConnectionUsable(): void
    {
        self::assertTrue((new ReflectionMethod(Cancellation::class, 'cancel'))->isInternal());
        self::assertTrue((new ReflectionMethod(Db::class, 'withCancellation'))->isInternal());

        $pdo = Sqlite::connect('sqlite::memory:');
        $root = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $cancellation = new Cancellation();
        $cancelled = $root->withCancellation($cancellation);

        try {
            self::assertSqliteQueryCancelled(
                $pdo,
                $root,
                $cancelled,
                $cancellation,
                'cancellation_native_rollback',
                'cancel_native'
            );
            self::assertSame([[1]], $root->fetch('select', [], null, 'SELECT 1'));
        } finally {
            $root->close();
        }
    }
}
