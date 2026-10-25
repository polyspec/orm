<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;
use PDO;

final class FailingSqliteLockPdo extends PDO
{
    public array $pragmas = [
        'foreign_keys' => 1,
        'legacy_alter_table' => 1,
        'busy_timeout' => 1300,
        'locking_mode' => 'normal',
    ];

    /** @var list<string> */
    public array $unexpected = [];

    /** @var list<string> */
    public array $operations = [];

    public function __construct(private PDOException $failure)
    {
    }

    public function failure(): PDOException
    {
        return $this->failure;
    }

    public function getAttribute(int $attribute): mixed
    {
        return PDO::ERRMODE_EXCEPTION;
    }

    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        $this->operations[] = "QUERY $query";
        $name = match ($query) {
            'PRAGMA foreign_keys' => 'foreign_keys',
            'PRAGMA legacy_alter_table' => 'legacy_alter_table',
            'PRAGMA busy_timeout' => 'busy_timeout',
            'PRAGMA locking_mode' => 'locking_mode',
            'SELECT COUNT(*) FROM sqlite_master' => null,
            default => throw new \RuntimeException("unexpected SQLite lock-test query: $query"),
        };
        return new FakeSqliteLockStatement([$name === null ? 0 : $this->pragmas[$name]]);
    }

    public function exec(string $statement): int|false
    {
        $this->operations[] = $statement;
        if ($statement === 'BEGIN EXCLUSIVE') {
            throw $this->failure;
        }
        if (
            preg_match(
                '/^PRAGMA (foreign_keys|legacy_alter_table|busy_timeout|locking_mode) = (.+)$/',
                $statement,
                $match,
            ) === 1
        ) {
            $value = trim($match[2]);
            if ($match[1] === 'locking_mode') {
                $this->pragmas[$match[1]] = strtolower($value);
            } else {
                $this->pragmas[$match[1]] = (int) $value;
            }
        } else {
            $this->unexpected[] = $statement;
        }
        return 0;
    }
}
