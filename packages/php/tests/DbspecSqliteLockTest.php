<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;
use PDO;
use Polyspec\Orm\Dbspec\PlanApply;
use PHPUnit\Framework\TestCase;

final class FakeSqliteLockStatement extends \PDOStatement
{
    public function __construct(private array $row) {}

    public function execute(?array $params = null): bool
    {
        return true;
    }

    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed
    {
        return $this->row;
    }

    public function closeCursor(): bool
    {
        return true;
    }
}

final class FailingSqliteLockPdo extends PDO
{
    public function __construct(private PDOException $failure) {}

    public function getAttribute(int $attribute): mixed
    {
        return PDO::ERRMODE_EXCEPTION;
    }

    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        $values = [
            'PRAGMA foreign_keys' => [1],
            'PRAGMA legacy_alter_table' => [0],
            'PRAGMA busy_timeout' => [5000],
            'PRAGMA locking_mode' => ['normal'],
            'SELECT COUNT(*) FROM sqlite_master' => [0],
        ];
        return new FakeSqliteLockStatement([$values[$query][0] ?? null]);
    }

    public function exec(string $statement): int|false
    {
        if ($statement === 'BEGIN EXCLUSIVE') {
            throw $this->failure;
        }
        return 0;
    }
}

final class DbspecSqliteLockTest extends TestCase
{
    private static function driverFailure(int $code): PDOException
    {
        $error = new PDOException("SQLite result $code");
        $error->errorInfo = ['HY000', $code, 'synthetic driver result'];
        return $error;
    }

    private static function applyFailure(PDOException $error): \Throwable
    {
        try {
            PlanApply::apply(
                new FailingSqliteLockPdo($error),
                'sqlite',
                [],
                static fn() => new \DateTimeImmutable(),
                null
            );
        } catch (\Throwable $caught) {
            return $caught;
        }
        throw new \RuntimeException('SQLite apply did not fail');
    }

    public function testOnlySqliteBusyAndLockedErrorInfoCodesAreClassifiedAsLocks(): void
    {
        foreach ([5, 6, 261, 517, 773, 262, 518] as $code) {
            $error = self::driverFailure($code);
            $caught = self::applyFailure($error);
            if (!$caught instanceof \Polyspec\Orm\Dbspec\ApplyError) {
                self::fail('SQLite busy or locked result did not produce ApplyError');
            }
            self::assertSame('locked', $caught->code_);
            self::assertSame($error, $caught->getPrevious());
        }
    }

    public function testNonLockAndMissingPdoCodesPreserveTheOriginalException(): void
    {
        foreach ([10, 8, 14, 23, 1] as $code) {
            $error = self::driverFailure($code);
            self::assertSame($error, self::applyFailure($error));
        }
        foreach ([[], ['HY000', null, 'missing'], ['HY000', '5', 'non-integer'], ['HY000', 'HY000', 'state']] as $info) {
            $error = new PDOException('synthetic PDO exception');
            $error->errorInfo = $info;
            self::assertSame($error, self::applyFailure($error));
        }
    }
}
