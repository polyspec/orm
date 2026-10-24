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
    public function testOnlySqliteBusyAndLockedErrorInfoCodesAreClassifiedAsLocks(): void
    {
        foreach ([5, 6, 261, 517, 773, 262, 518] as $code) {
            $error = new PDOException("SQLite result $code");
            $error->errorInfo = ['HY000', $code, 'synthetic driver result'];
            try {
                PlanApply::apply(new FailingSqliteLockPdo($error), 'sqlite', [], static fn() => new \DateTimeImmutable(), null);
                self::fail("result code $code did not fail");
            } catch (\Polyspec\Orm\Dbspec\ApplyError $caught) {
                self::assertSame('locked', $caught->code_);
                self::assertSame($error, $caught->getPrevious());
            }
        }
    }

    public function testNonLockAndMissingPdoCodesPreserveTheOriginalException(): void
    {
        foreach ([10, 8, 14, 23, 1] as $code) {
            $error = new PDOException("SQLite result $code");
            $error->errorInfo = ['HY000', $code, 'synthetic driver result'];
            try {
                PlanApply::apply(new FailingSqliteLockPdo($error), 'sqlite', [], static fn() => new \DateTimeImmutable(), null);
                self::fail("result code $code did not fail");
            } catch (PDOException $caught) {
                self::assertSame($error, $caught);
            }
        }
        foreach ([[], ['HY000', null, 'missing'], ['HY000', '5', 'non-integer'], ['HY000', 'HY000', 'state']] as $info) {
            $error = new PDOException('synthetic PDO exception');
            $error->errorInfo = $info;
            try {
                PlanApply::apply(new FailingSqliteLockPdo($error), 'sqlite', [], static fn() => new \DateTimeImmutable(), null);
                self::fail('a missing or non-integer driver code did not fail');
            } catch (PDOException $caught) {
                self::assertSame($error, $caught);
            }
        }
    }
}
