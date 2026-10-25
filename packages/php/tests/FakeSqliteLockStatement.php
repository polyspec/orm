<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;

final class FakeSqliteLockStatement extends \PDOStatement
{
    public function __construct(private array $row)
    {
    }

    public function execute(?array $params = null): bool
    {
        return true;
    }

    public function fetch(
        int $mode = PDO::FETCH_DEFAULT,
        int $cursorOrientation = PDO::FETCH_ORI_NEXT,
        int $cursorOffset = 0,
    ): mixed {
        return $this->row;
    }

    public function closeCursor(): bool
    {
        return true;
    }
}
