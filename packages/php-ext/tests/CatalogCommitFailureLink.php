<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CatalogCommitFailureLink extends \mysqli
{
    public int $rollbackCalls = 0;

    public function __construct(private readonly bool $failRollback)
    {
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- mysqli dispatch requires this exact API method name.
    public function begin_transaction(int $flags = MYSQLI_TRANS_START_READ_WRITE, ?string $name = null): bool
    {
        return true;
    }

    public function prepare(string $query): \mysqli_stmt|false
    {
        return new CatalogCommitFailureStatement();
    }

    public function commit(int $flags = 0, ?string $name = null): bool
    {
        throw new \mysqli_sql_exception('grid commit failed');
    }

    public function rollback(int $flags = 0, ?string $name = null): bool
    {
        $this->rollbackCalls++;
        if ($this->failRollback) {
            throw new \mysqli_sql_exception('grid rollback failed');
        }
        return true;
    }
}
