<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;
use RuntimeException;

/**
 * A PDO whose query() answers the catalog queries of MySQL introspection from the canned catalog. The rows are
 * returned by a statement of an in-memory SQLite database, so introspection reads them through the PDOStatement
 * API as it reads a MySQL connection.
 */
final class CannedCatalogPdo extends PDO
{
    /** @param array<string, mixed> $catalog */
    public function __construct(
        private readonly array $catalog,
        private readonly string $create,
        private readonly string $checkName
    ) {
        parent::__construct('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        [$rows, $width] = $this->answer($query);
        $params = [];
        $selects = [];
        foreach ($rows as $row) {
            $selects[] = 'SELECT ' . implode(', ', array_fill(0, count($row), '?'));
            array_push($params, ...$row);
        }
        $sql = $selects === []
            ? 'SELECT ' . implode(', ', array_fill(0, $width, 'NULL')) . ' WHERE 0'
            : implode(' UNION ALL ', $selects);
        $statement = parent::prepare($sql);
        $statement->execute($params);
        $statement->setFetchMode(PDO::FETCH_NUM);
        return $statement;
    }

    /** The rows of one catalog query and the number of its columns. */
    private function answer(string $query): array
    {
        $table = $this->catalog['table'];
        if (str_contains($query, 'information_schema.TABLES')) {
            return [[[$table, 'BASE TABLE', '']], 3];
        }
        if (str_contains($query, 'information_schema.COLUMNS')) {
            $rows = [];
            foreach ($this->catalog['columns'] as $column) {
                $rows[] = [
                    $table,
                    $column['name'],
                    $column['type'],
                    $column['nullable'],
                    null,
                    '',
                    $column['charset'],
                    $column['collation'],
                    ''
                ];
            }
            return [$rows, 9];
        }
        if (str_contains($query, 'information_schema.STATISTICS')) {
            return [[[$table, 'PRIMARY', 0, $this->catalog['primary_key'], 'A', 0, 0, 'BTREE']], 8];
        }
        if (str_contains($query, 'REFERENTIAL_CONSTRAINTS')) {
            return [[], 8];
        }
        if (str_contains($query, 'CHECK_CONSTRAINTS')) {
            return [[[$this->checkName, $this->catalog['stored_clause']]], 2];
        }
        if (str_contains($query, 'TABLE_CONSTRAINTS')) {
            return [[[$table, $this->checkName, 'YES']], 3];
        }
        if (str_contains($query, 'information_schema.TRIGGERS')) {
            return [[], 5];
        }
        if (str_contains($query, 'information_schema.ROUTINES') || str_contains($query, 'information_schema.EVENTS')) {
            return [[], 1];
        }
        if (str_contains($query, 'SHOW CREATE TABLE')) {
            return [[[$table, $this->create]], 2];
        }
        throw new RuntimeException("CannedCatalogPdo has no answer for the query $query");
    }
}
