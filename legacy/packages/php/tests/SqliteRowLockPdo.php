<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;
use PDOStatement;

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
