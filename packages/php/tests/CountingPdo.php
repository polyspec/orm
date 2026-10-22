<?php

declare(strict_types=1);

/** Counts the catalog queries sent by introspection. */
final class CountingPdo extends PDO
{
    public int $queries = 0;

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $this->queries++;
        return parent::query($query, $fetchMode, ...$fetchModeArgs);
    }
}
