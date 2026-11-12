<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;

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
