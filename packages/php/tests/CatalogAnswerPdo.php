<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;

/**
 * A connection without a server whose prepared statements take their rows, column names and native types from
 * answer(), so the catalog reads them through the PDOStatement API as it reads a MySQL or PostgreSQL connection.
 */
abstract class CatalogAnswerPdo extends PDO
{
    public function setAttribute(int $attribute, mixed $value): bool
    {
        return true;
    }

    public function exec(string $statement): int|false
    {
        return 0;
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        return new CatalogAnswerStatement($this, $query);
    }

    /** @return array{list<array<mixed>>, list<string>, list<string>} the rows, names and native types of a query */
    abstract public function answer(string $query): array;
}
