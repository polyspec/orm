<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use Pdo\Sqlite;
use Polyspec\Orm\Cancellation;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// Requirements: CFG-9.
#[Medium]
final class QueryCancellationTest extends TestCase
{
    use QueryCancellationDbCases;

    public function testCancellationStateIsPrivatePersistentAndRemovedWhenReleased(): void
    {
        $cancellation = new Cancellation();
        $path = $cancellation->statePath();
        self::assertCancellationStateTransitions($cancellation, $path);

        unset($cancellation);
        self::assertFileDoesNotExist($path);
    }

    public function testCancellationOnlyCallsCallbacksForActiveConnectionSlotsAndIsIdempotent(): void
    {
        $cancellation = new Cancellation();
        $firstCalls = 0;
        $secondCalls = 0;
        $firstSlot = $cancellation->registerCancelQuery(101, self::countingCancelQuery($firstCalls));
        $secondSlot = $cancellation->registerCancelQuery(202, self::countingCancelQuery($secondCalls));

        $cancellation->begin($firstSlot);
        self::assertSame("\1\1\0", file_get_contents($cancellation->statePath()));
        $cancellation->cancel();
        self::assertSame(1, $firstCalls);
        self::assertSame(0, $secondCalls);
        self::assertSame("\3\1\0", file_get_contents($cancellation->statePath()));

        $cancellation->end($firstSlot);
        $cancellation->cancel();
        self::assertSame(1, $firstCalls, 'a repeated cancellation does not rerun the callback');
        self::assertSame(0, $secondCalls);
        self::assertSame("\2\0\0", file_get_contents($cancellation->statePath()));
        unset($cancellation);
    }

    public function testCancellationCallsEachActiveConnectionSlot(): void
    {
        $cancellation = new Cancellation();
        $calls = [0, 0];
        $firstSlot = $cancellation->registerCancelQuery(101, static function () use (&$calls): void {
            $calls[0]++;
        });
        $secondSlot = $cancellation->registerCancelQuery(202, static function () use (&$calls): void {
            $calls[1]++;
        });
        $cancellation->begin($firstSlot);
        $cancellation->begin($secondSlot);

        $cancellation->cancel();
        self::assertSame([1, 1], $calls);
        self::assertSame("\3\1\1", file_get_contents($cancellation->statePath()));
        $cancellation->end($firstSlot);
        self::assertSame("\3\0\1", file_get_contents($cancellation->statePath()));
        $cancellation->end($secondSlot);
        self::assertSame("\2\0\0", file_get_contents($cancellation->statePath()));
        unset($cancellation);
    }

    public function testCancellationInterruptsSqliteVmRollsBackAndKeepsRootConnectionUsable(): void
    {
        $pdo = Sqlite::connect('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $root = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $cancellation = new Cancellation();
        $cancelled = $root->withCancellation($cancellation);
        $otherPdo = Sqlite::connect('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $otherRoot = new Db($otherPdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        $otherCancelled = $otherRoot->withCancellation($cancellation);
        self::assertSame([[1]], $otherCancelled->fetch('select', [], null, 'SELECT 1'));

        try {
            self::assertSqliteQueryCancelled($pdo, $root, $cancelled, $cancellation, 'cancellation_rollback', 'cancel');
            self::assertSame(
                [[1]],
                $otherRoot->fetch('select', [], null, 'SELECT 1'),
                'a root view without the cancellation token keeps using its idle SQLite connection'
            );
            self::assertSame([[1]], $root->fetch('select', [], null, 'SELECT 1'));
        } finally {
            $root->close();
            $otherRoot->close();
        }
    }
}
