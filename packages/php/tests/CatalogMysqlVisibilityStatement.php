<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;

final class CatalogMysqlVisibilityStatement extends PDOStatement
{
    /** @var list<array<string, mixed>> */
    private array $rows = [];
    /** @var list<string> */
    private array $names = [];
    /** @var list<string> */
    private array $types = [];
    private int $index = 0;
    private int $affected = 0;

    public function __construct(private readonly CatalogMysqlVisibilityPdo $pdo, private readonly string $query)
    {
    }

    public function execute(?array $params = null): bool
    {
        [$this->rows, $this->names, $this->types] = $this->pdo->answer($this->query);
        $this->index = 0;
        $this->affected = str_starts_with($this->query, 'INSERT INTO') ? 1 : count($this->rows);
        return true;
    }

    public function columnCount(): int
    {
        return count($this->names);
    }

    public function getColumnMeta(int $column): array|false
    {
        return ['name' => $this->names[$column], 'native_type' => $this->types[$column]];
    }

    public function fetch(
        int $mode = PDO::FETCH_DEFAULT,
        int $cursorOrientation = PDO::FETCH_ORI_NEXT,
        int $cursorOffset = 0
    ): mixed {
        if (!isset($this->rows[$this->index])) {
            return false;
        }
        $row = $this->rows[$this->index++];
        return array_values($row);
    }

    public function rowCount(): int
    {
        return $this->affected;
    }
}
