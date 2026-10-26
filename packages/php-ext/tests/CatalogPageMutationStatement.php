<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CatalogPageMutationStatement extends \PDOStatement
{
    /** @var list<array{name: string, native_type: string}> */
    private array $columns = [];
    /** @var list<list<mixed>> */
    private array $rows = [];
    private int $rowIndex = 0;

    public function __construct(private readonly CatalogPageMutationPdo $pdo, private readonly string $query)
    {
    }

    public function execute(?array $params = null): bool
    {
        $result = $this->pdo->resultFor($this->query);
        $this->columns = $result['columns'];
        $this->rows = $result['rows'];
        return true;
    }

    public function columnCount(): int
    {
        return count($this->columns);
    }

    public function getColumnMeta(int $column): array|false
    {
        return $this->columns[$column] ?? false;
    }

    public function fetch(
        int $mode = \PDO::FETCH_DEFAULT,
        int $cursorOrientation = \PDO::FETCH_ORI_NEXT,
        int $cursorOffset = 0
    ): mixed {
        return $this->rows[$this->rowIndex++] ?? false;
    }
}
