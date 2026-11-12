<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\Orm;

/** Shared assertions for the generated-row write set across the PHP library and native extension. */
final class WasInsertedCases
{
    private static bool $generated = false;

    public static function loadFixture(): void
    {
        if (self::$generated) {
            return;
        }
        loadGeneratedFixture(
            'orm-php-was-inserted-',
            'clock.dbs',
            'Polyspec\Orm\Tests\WasInsertedCase'
        );
        self::$generated = true;
    }

    public static function onSqlite(\Closure $body): void
    {
        self::loadFixture();
        $path = tempnam(sys_get_temp_dir(), 'orm-was-inserted-');
        if (!is_string($path)) {
            throw new \RuntimeException('cannot create the SQLite test file');
        }
        $db = null;
        try {
            $db = Orm::connect('sqlite://' . $path, new Config());
            $db->utils()->schema()->install(\Polyspec\Orm\Tests\WasInsertedCase\schema());
            $body($db);
        } finally {
            try {
                if ($db instanceof Db) {
                    $db->close();
                }
            } finally {
                if (is_file($path) && !unlink($path)) {
                    throw new \RuntimeException("cannot remove the SQLite test file $path");
                }
            }
        }
    }

    /** Runs the case on a new case database of $driver, dropped afterwards, with the connection and its DSN. */
    public static function onCase(string $driver, \Closure $body): void
    {
        self::loadFixture();
        with_case_database($driver, static function (string $step): void {
        }, static function (string $dsn) use ($body): void {
            $db = Orm::connect($dsn . (str_contains($dsn, '?') ? '&' : '?') . 'timezone=%2B00:00', new Config());
            try {
                $db->utils()->schema()->install(\Polyspec\Orm\Tests\WasInsertedCase\schema());
                $body($db, $dsn);
            } finally {
                $db->close();
            }
        });
    }

    /** The seq of a clock event labelled 'held' that a committed transaction of $db created. */
    public static function heldEventSeq(Db $db): int
    {
        $seq = 0;
        $db->transaction(static function () use ($db, &$seq): void {
            $seq = (int) (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)->setLabel('held')
                ->create()
                ->getSeq();
        }, retry: 0);
        return $seq;
    }

    /**
     * Updates the clock event $seq through $db, inside the caller's transaction, so that the transaction holds its row
     * lock, and starts was_inserted_child.php, which updates the clock event $seq of the database of $dsn and so waits
     * for the row lock that the caller's transaction holds; $pipes receives its standard output and error.
     *
     * @param array<int, resource> $pipes
     * @return resource|false
     */
    public static function startLockWaiter(Db $db, string $dsn, int $seq, array &$pipes): mixed
    {
        (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)->getBySeq($seq)
            ->setLabel('parent')
            ->update();
        return proc_open(
            [PHP_BINARY, __DIR__ . '/was_inserted_child.php', $dsn, (string) $seq],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
    }

    public static function assertTracksGeneratedRows(TestCase $test, Db $db): void
    {
        $existing = 0;
        $db->transaction(function () use ($db, &$existing): void {
            $row = (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)
                ->setLabel('existing')
                ->create();
            $existing = (int) $row->getSeq();
        }, retry: 0);

        $outer = 0;
        $nested = 0;
        $db->transaction(function () use ($db, $test, $existing, &$outer, &$nested): void {
            $row = (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)
                ->setLabel('outer')
                ->create();
            $outer = (int) $row->getSeq();
            $test::assertTrue($db->utils()->wasInserted('clock_event', $outer), 'the outer insert is recorded');
            $test::assertFalse(
                $db->utils()->wasInserted('clock_event', $existing),
                'a row committed before this transaction is not recorded'
            );
            $test::assertFalse(
                $db->utils()->wasInserted('clock_event', $outer + 1000),
                'a key that was never inserted is not recorded'
            );
            try {
                $db->transaction(function () use ($db, $test, &$nested): void {
                    $row = (new \Polyspec\Orm\Tests\WasInsertedCase\ClockEvent())($db)
                        ->setLabel('nested')
                        ->create();
                    $nested = (int) $row->getSeq();
                    $test::assertTrue(
                        $db->utils()->wasInserted('clock_event', $nested),
                        'the nested insert is recorded'
                    );
                    throw new \RuntimeException('roll back the nested savepoint');
                }, retry: 0);
                $test::fail('the nested transaction unexpectedly committed');
            } catch (\RuntimeException $rolledBack) {
                $test::assertInstanceOf(\RuntimeException::class, $rolledBack, 'the nested savepoint rolled back');
            }
            $test::assertFalse(
                $db->utils()->wasInserted('clock_event', $nested),
                'a rolled back insert leaves the write set'
            );
            $test::assertTrue(
                $db->utils()->wasInserted('clock_event', $outer),
                'the outer insert survives a nested rollback'
            );
        }, retry: 0);
    }
}
