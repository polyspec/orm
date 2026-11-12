<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDOStatement;

/**
 * The query of a PDO subclass whose statements are its own adapters: the statement is prepared and executed, and it
 * takes the fetch mode that query names. Shared by PgsqlPdoAdapter and MarkdownPdoAdapter.
 *
 * @internal
 */
trait QueriesByPrepare
{
    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $statement = $this->prepare($query);
        if ($statement === false || !$statement->execute()) {
            return false;
        }
        if ($fetchMode !== null) {
            $statement->setFetchMode($fetchMode, ...$fetchModeArgs);
        }
        return $statement;
    }
}
