<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

use PDO;

/**
 * The fetchAll of a PDOStatement subclass that answers its rows through fetch(): the rows are read in order until fetch()
 * returns false. Shared by PgsqlStatementAdapter and the test statement CatalogAnswerStatement.
 *
 * @internal
 */
trait FetchesAllRows
{
    /** @return list<array<mixed>> the rest of the rows */
    public function fetchAll(int $mode = PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        $rows = [];
        while (($row = $this->fetch($mode)) !== false) {
            $rows[] = $row;
        }
        return $rows;
    }
}
