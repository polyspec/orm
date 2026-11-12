<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDO;

/**
 * The fetch mode and the error state of a PDOStatement subclass that answers its rows through fetch(), as a PDO
 * statement keeps them: setFetchMode names the mode that a fetch of PDO::FETCH_DEFAULT takes, errorCode and errorInfo
 * read the state of the last execute, and fetchColumn reads one column of the next row. Shared by
 * PgsqlStatementAdapter and MarkdownStatementAdapter.
 *
 * @internal
 */
trait StatementState
{
    /** @var array<int, mixed> the fetch mode and its arguments, as setFetchMode received them */
    private array $fetchMode = [];
    /** @var array{0: ?string, 1: mixed, 2: mixed} the SQLSTATE, driver code and driver message of the last execute */
    private array $errorInfoValue = ['00000', null, null];

    public function setFetchMode(int $mode, mixed ...$args): true
    {
        $this->fetchMode = [$mode, ...$args];
        return true;
    }

    public function errorCode(): ?string
    {
        return $this->errorInfoValue[0];
    }

    public function errorInfo(): array
    {
        return $this->errorInfoValue;
    }

    /**
     * The slot of a parameter as bindValue names it: a position from 1 is its index from 0, and a name is itself
     * without its colon.
     */
    private static function slotOf(string|int $param): int|string
    {
        if (is_int($param)) {
            return $param - 1;
        }
        return str_starts_with($param, ':') ? substr($param, 1) : $param;
    }

    /**
     * @param array<int|string, mixed> $params the params of an execute
     * @return array<int|string, mixed> the params by their slot: a position of the list as it is, a name by slotOf
     */
    private static function executeSlots(array $params): array
    {
        $slots = [];
        foreach ($params as $key => $value) {
            $slots[is_int($key) ? $key : self::slotOf($key)] = $value;
        }
        return $slots;
    }

    public function fetchColumn(int $column = 0): mixed
    {
        $row = $this->fetch(PDO::FETCH_NUM);
        return $row === false ? false : ($row[$column] ?? false);
    }
}
