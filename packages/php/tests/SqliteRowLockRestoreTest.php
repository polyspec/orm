<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use DateTimeZone;
use PDO;
use PDOException;
use PDOStatement;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;
use RuntimeException;

final class SqliteRowLockRestoreTest extends TestCase
{
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

final class SqliteRowLockPdo extends UninitializedRecordingPdo
{
    public array $calls = [];

    public function __construct(
        private readonly bool $failPrimary = false,
        private readonly ?\Throwable $failRestore = null,
        private readonly ?\Throwable $failSetup = null
    ) {
    }

    public function exec(string $statement): int|false
    {
        $this->recordStatement($statement);
        if ($statement === 'PRAGMA busy_timeout=0' && $this->failSetup !== null) {
            throw $this->failSetup;
        }
        if ($statement === 'PRAGMA busy_timeout=375' && $this->failRestore !== null) {
            throw $this->failRestore;
        }
        if (str_starts_with($statement, 'INSERT') && $this->failPrimary) {
            $error = new PDOException('database is locked');
            $error->errorInfo = ['HY000', 5, 'database is locked'];
            throw $error;
        }
        return 1;
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->recordStatement($query);
        return new SqliteRowLockStatement($query);
    }

    protected function recordStatement(string $statement): void
    {
        $this->calls[] = $statement;
    }
}

final class SqliteRowLockStatement extends PDOStatement
{
    public function __construct(private readonly string $query)
    {
    }
    public function execute(?array $params = null): bool
    {
        return true;
    }
    public function columnCount(): int
    {
        return $this->query === 'PRAGMA busy_timeout' ? 1 : 0;
    }
    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        return [[375]];
    }
    public function closeCursor(): bool
    {
        return true;
    }
}
