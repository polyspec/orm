<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;
use RuntimeException;

final class CatalogMysqlVisibilityPdo extends PDO
{
    /** @var list<string> */
    public array $queries = [];
    public bool $inserted = false;

    public function __construct(private readonly int $partialRevokes, private readonly bool $directGrant)
    {
    }

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
        return new CatalogMysqlVisibilityStatement($this, $query);
    }

    /** @return array{list<array<string, mixed>>, list<string>, list<string>} */
    public function answer(string $query): array
    {
        $this->queries[] = $query;
        if ($query === 'SELECT CAST(@@GLOBAL.partial_revokes AS SIGNED)') {
            return [[['value' => $this->partialRevokes]], ['value'], ['LONGLONG']];
        }
        if ($query === 'SELECT CURRENT_USER()') {
            return [[['value' => 'orm@localhost']], ['value'], ['VAR_STRING']];
        }
        if (str_contains($query, 'information_schema.USER_PRIVILEGES')) {
            $rows = $this->directGrant ? [['value' => 'TRIGGER']] : [];
            return [$rows, ['value'], ['VAR_STRING']];
        }
        if (str_contains($query, 'information_schema.TABLES') && str_contains($query, 'TABLE_TYPE')) {
            return [[['TABLE_TYPE' => 'BASE TABLE']], ['TABLE_TYPE'], ['VAR_STRING']];
        }
        if (str_contains($query, 'information_schema.COLUMNS')) {
            return [
                [
                    [
                        'COLUMN_NAME' => 'id',
                        'COLUMN_TYPE' => 'BIGINT',
                        'IS_NULLABLE' => 0,
                        'GENERATED' => 0,
                        'ORDINAL_POSITION' => 1,
                        'AUTO_KEY' => 0,
                        'COLUMN_DEFAULT' => null,
                        'EXPRESSION_DEFAULT' => 0,
                    ],
                    [
                        'COLUMN_NAME' => 'value',
                        'COLUMN_TYPE' => 'VARCHAR(32)',
                        'IS_NULLABLE' => 0,
                        'GENERATED' => 0,
                        'ORDINAL_POSITION' => 0,
                        'AUTO_KEY' => 0,
                        'COLUMN_DEFAULT' => null,
                        'EXPRESSION_DEFAULT' => 0,
                    ],
                ],
                [
                    'COLUMN_NAME',
                    'COLUMN_TYPE',
                    'IS_NULLABLE',
                    'GENERATED',
                    'ORDINAL_POSITION',
                    'AUTO_KEY',
                    'COLUMN_DEFAULT',
                    'EXPRESSION_DEFAULT',
                ],
                ['VAR_STRING', 'VAR_STRING', 'LONGLONG', 'LONGLONG', 'LONGLONG', 'LONGLONG', 'VAR_STRING', 'LONGLONG'],
            ];
        }
        if (str_starts_with($query, 'SELECT `id`,`value` FROM')) {
            return [
                $this->inserted ? [['id' => 1, 'value' => 'visible']] : [],
                ['id', 'value'],
                ['LONGLONG', 'VAR_STRING'],
            ];
        }
        if (str_contains($query, 'information_schema.TABLES') && str_contains($query, 'ENGINE')) {
            return [[['ENGINE' => 'InnoDB']], ['ENGINE'], ['VAR_STRING']];
        }
        if (str_contains($query, 'information_schema.TRIGGERS')) {
            return [[], ['TRIGGER_NAME'], ['VAR_STRING']];
        }
        if (str_contains($query, 'information_schema.USER_PRIVILEGES')) {
            return [$this->directGrant ? [['PRIVILEGE_TYPE' => 'TRIGGER']] : [], ['PRIVILEGE_TYPE'], ['VAR_STRING']];
        }
        if (str_starts_with($query, 'INSERT INTO')) {
            $this->inserted = true;
            return [[], [], []];
        }
        throw new RuntimeException('Unexpected MySQL visibility query: ' . $query);
    }
}
