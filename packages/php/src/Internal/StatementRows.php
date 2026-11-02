<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDO;

/** @internal */
final class StatementRows
{
    /**
     * The rows that a statement fetches from its current position to its end, each in the given fetch mode.
     *
     * @param callable(int): mixed $fetch the statement's fetch, which returns false at the end of its rows
     */
    public static function fetchAll(callable $fetch, int $mode = PDO::FETCH_DEFAULT): array
    {
        $rows = [];
        while (($row = $fetch($mode)) !== false) {
            $rows[] = $row;
        }
        return $rows;
    }
}
