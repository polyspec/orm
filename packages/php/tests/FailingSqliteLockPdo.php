<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;
use PDO;

final class FailingSqliteLockPdo extends PDO
{
    public function __construct(private PDOException $failure)
    {
    }

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
