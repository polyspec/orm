<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;

/** A fake PDO's rows as typed literals in an in-memory SQLite statement. */
trait SqliteLiteralRowsPdo
{
    /** @param list<list<mixed>> $rows */
    private function queryRows(array $rows, int $emptyWidth = 1): PDOStatement|false
    {
        $literal = fn (mixed $value): string => match (true) {
            $value === null => 'NULL',
            is_int($value), is_float($value) => var_export($value, true),
            default => $this->quote((string)$value),
        };
        $selects = array_map(
            static fn (array $row): string => 'SELECT ' . implode(', ', array_map($literal, $row)),
            $rows,
        );
        $empty = 'SELECT ' . implode(', ', array_fill(0, $emptyWidth, 'NULL')) . ' WHERE 0';
        return parent::query($rows === [] ? $empty : implode(' UNION ALL ', $selects), PDO::FETCH_NUM);
    }
}
