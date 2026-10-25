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
