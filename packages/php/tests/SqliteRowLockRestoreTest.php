<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDOException;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use RuntimeException;

final class SqliteRowLockRestoreTest extends TestCase
{
    // Requirements: INT-49.
    public function testProductionCallerPreservesPrimaryAndRestorationOutcomes(): void
    {
        $restore = new RuntimeException('restore rejected');
        foreach ([[false, false], [false, true], [true, false], [true, true]] as [$primary, $restoreFailure]) {
            $pdo = new SqliteRowLockPdo($primary, $restoreFailure ? $restore : null);
            $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
            if (!$primary && !$restoreFailure) {
                $db->acquireSQLiteRowLock('update_nowait');
            } else {
                try {
                    $db->acquireSQLiteRowLock('update_nowait');
                    self::fail('row lock unexpectedly succeeded');
                } catch (\Throwable $error) {
                    if ($primary) {
                        self::assertInstanceOf(OrmException::class, $error);
                        self::assertSame(Code::LOCK_NOT_AVAILABLE, $error->code_);
                        if ($restoreFailure) {
                            self::assertSame(1, count($error->cleanup));
                            self::assertSame($restore, $error->cleanup[0]);
                            self::assertInstanceOf(OrmException::class, $error->getPrevious());
                        } else {
                            self::assertInstanceOf(PDOException::class, $error->getPrevious());
                        }
                    } else {
                        self::assertSame($restore, $error);
                    }
                }
            }
            self::assertSame('PRAGMA busy_timeout=375', end($pdo->calls));
        }

        $setup = new PDOException('busy while setting NOWAIT');
        $setup->errorInfo = ['HY000', 5, 'busy while setting NOWAIT'];
        $pdo = new SqliteRowLockPdo(false, $restore, $setup);
        $db = new Db($pdo, 'sqlite', new Config(), new DateTimeZone('UTC'));
        try {
            $db->acquireSQLiteRowLock('update_nowait');
            self::fail('NOWAIT setup unexpectedly succeeded');
        } catch (OrmException $error) {
            self::assertSame(Code::CANCELED, $error->code_);
            self::assertInstanceOf(OrmException::class, $error->getPrevious());
            self::assertSame($setup, $error->getPrevious()->getPrevious());
            self::assertSame($restore, $error->cleanup[0]);
        }
        self::assertSame('PRAGMA busy_timeout=375', end($pdo->calls));
    }
}
