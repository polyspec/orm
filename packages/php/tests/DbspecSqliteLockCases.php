<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\PlanApply;

final class DbspecSqliteLockCases
{
    public static function assertLockCodes(TestCase $test): void
    {
        foreach ([5, 6, 261, 517, 773, 262, 518] as $code) {
            [$caught, $driver, $initial] = self::applyFailure($code);
            $test->assertInstanceOf(\Polyspec\Orm\Dbspec\ApplyError::class, $caught);
            $test->assertSame('locked', $caught->code_);
            // A lock result of the release read, which held no lock, adds no cleanup error.
            $test->assertSame($driver->failure(), $caught->getPrevious());
            self::assertRestored($test, $driver, $initial, $code, true);
        }
    }

    public static function assertNonLockCauses(TestCase $test): void
    {
        foreach ([10, 8, 14, 23, 1] as $code) {
            [$caught, $driver, $initial] = self::applyFailure($code);
            $test->assertSame($driver->failure(), $caught);
            self::assertRestored($test, $driver, $initial, $code);
        }
        foreach (
            [
                [],
                ['HY000', null, 'missing'],
                ['HY000', '5', 'non-integer'],
                ['HY000', 'HY000', 'state'],
            ] as $info
        ) {
            $error = new PDOException('synthetic PDO exception');
            $error->errorInfo = $info;
            [$caught, $driver, $initial] = self::applyFailure($error);
            $test->assertSame($error, $caught);
            self::assertRestored($test, $driver, $initial, $info);
        }
    }

    /** @return array{\Throwable, FailingSqliteLockPdo, array<string, int|string>} */
    private static function applyFailure(int|PDOException $error): array
    {
        if (is_int($error)) {
            $cause = new PDOException("SQLite result $error");
            $cause->errorInfo = ['HY000', $error, 'synthetic driver result'];
        } else {
            $cause = $error;
        }
        $driver = new FailingSqliteLockPdo($cause, is_int($error) && in_array($error & 0xff, [5, 6], true));
        $initial = $driver->pragmas;
        try {
            PlanApply::apply(
                $driver,
                'sqlite',
                [],
                static fn() => new \DateTimeImmutable(),
                null
            );
        } catch (\Throwable $caught) {
            return [$caught, $driver, $initial];
        }
        throw new \RuntimeException('SQLite apply did not fail');
    }

    private static function assertRestored(
        TestCase $test,
        FailingSqliteLockPdo $driver,
        array $initial,
        mixed $case,
        bool $locked = false,
    ): void {
        $label = json_encode($case, JSON_THROW_ON_ERROR);
        $test->assertSame($initial, $driver->pragmas, "SQLite PRAGMAs were not restored for result $label");
        $test->assertSame([], $driver->unexpected, "SQLite lock failure ran non-session work for result $label");
        $test->assertSame(
            [
                'QUERY PRAGMA foreign_keys',
                'QUERY PRAGMA legacy_alter_table',
                'QUERY PRAGMA busy_timeout',
                'QUERY PRAGMA locking_mode',
                'PRAGMA busy_timeout = 5000',
                'PRAGMA locking_mode = EXCLUSIVE',
                'BEGIN EXCLUSIVE',
                // The release read does not wait for the lock that another connection holds.
                ...($locked ? ['PRAGMA busy_timeout = 0'] : []),
                'PRAGMA foreign_keys = 1',
                'PRAGMA legacy_alter_table = 1',
                'PRAGMA locking_mode = normal',
                'QUERY SELECT COUNT(*) FROM sqlite_master',
                'PRAGMA busy_timeout = 1300',
            ],
            $driver->operations,
            "SQLite session settings or restore sequence changed for result $label"
        );
    }
}
