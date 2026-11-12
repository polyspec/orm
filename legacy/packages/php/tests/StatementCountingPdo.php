<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;

/** Counts all statements, prepares, and transaction starts that the connection sends to the database. */
final class StatementCountingPdo extends PDO
{
    public int $sent = 0;

    public function exec(string $statement): int|false
    {
        $this->sent++;
        return parent::exec($statement);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $this->sent++;
        return parent::query($query, $fetchMode, ...$fetchModeArgs);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        $this->sent++;
        return parent::prepare($query, $options);
    }

    public function beginTransaction(): bool
    {
        $this->sent++;
        return parent::beginTransaction();
    }
}
