<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;

final class CatalogMetadataFailureStatement extends \PDOStatement
{
    public static ?PDOException $failure = null;

    public function __construct()
    {
    }

    public function execute(?array $params = null): bool
    {
        return true;
    }

    public function columnCount(): int
    {
        return 3;
    }

    public function getColumnMeta(int $column): array|false
    {
        if ($column === 1) {
            throw self::$failure ?? new PDOException('column metadata failed');
        }
        return ['name' => "column_$column", 'native_type' => 'INTEGER'];
    }
}
