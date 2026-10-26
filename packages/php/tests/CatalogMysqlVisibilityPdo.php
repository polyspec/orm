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
                    ['COLUMN_NAME' => 'id', 'COLUMN_TYPE' => 'BIGINT', 'IS_NULLABLE' => 0, 'GENERATED' => 0, 'ORDINAL_POSITION' => 1, 'AUTO_KEY' => 0, 'COLUMN_DEFAULT' => null, 'EXPRESSION_DEFAULT' => 0],
                    ['COLUMN_NAME' => 'value', 'COLUMN_TYPE' => 'VARCHAR(32)', 'IS_NULLABLE' => 0, 'GENERATED' => 0, 'ORDINAL_POSITION' => 0, 'AUTO_KEY' => 0, 'COLUMN_DEFAULT' => null, 'EXPRESSION_DEFAULT' => 0],
                ],
                ['COLUMN_NAME', 'COLUMN_TYPE', 'IS_NULLABLE', 'GENERATED', 'ORDINAL_POSITION', 'AUTO_KEY', 'COLUMN_DEFAULT', 'EXPRESSION_DEFAULT'],
                ['VAR_STRING', 'VAR_STRING', 'LONGLONG', 'LONGLONG', 'LONGLONG', 'LONGLONG', 'VAR_STRING', 'LONGLONG'],
            ];
        }
        if (str_starts_with($query, 'SELECT `id`,`value` FROM')) {
            return [$this->inserted ? [['id' => 1, 'value' => 'visible']] : [], ['id', 'value'], ['LONGLONG', 'VAR_STRING']];
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

    public function fetch(int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed
    {
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

final class CatalogMysqlVisibilityCases
{
    /** @param callable(CatalogMysqlVisibilityPdo): \Polyspec\Orm\Catalog $makeCatalog */
    public static function assertPublicInsert(callable $makeCatalog): void
    {
        $metadata = new \Polyspec\Orm\CatalogTableMetadata(
            ['namespace' => 'app', 'name' => 'visibility_probe'],
            'table',
            [
                new \Polyspec\Orm\CatalogColumn('id', 'BIGINT', false, false, false, null, false),
                new \Polyspec\Orm\CatalogColumn('value', 'VARCHAR(32)', false, false, false, null, false),
            ],
            ['id'],
            true,
        );
        $directPdo = new CatalogMysqlVisibilityPdo(0, true);
        $result = $makeCatalog($directPdo)->insertRow($metadata, ['id' => 1, 'value' => 'visible']);
        \PHPUnit\Framework\Assert::assertSame([[1, 'visible']], $result->rows);
        \PHPUnit\Framework\Assert::assertContains('SELECT CURRENT_USER()', $directPdo->queries);
        \PHPUnit\Framework\Assert::assertContains(true, array_map(
            static fn (string $query): bool => str_contains($query, 'information_schema.USER_PRIVILEGES'),
            $directPdo->queries,
        ));
        \PHPUnit\Framework\Assert::assertContains(true, array_map(static fn (string $query): bool => str_starts_with($query, 'INSERT INTO'), $directPdo->queries));

        foreach ([
            'role-only grant' => [0, false],
            'enabled partial revokes' => [1, true],
        ] as $scenario => [$partialRevokes, $directGrant]) {
            $pdo = new CatalogMysqlVisibilityPdo($partialRevokes, $directGrant);
            try {
                $makeCatalog($pdo)->insertRow($metadata, ['id' => 1, 'value' => 'visible']);
                \PHPUnit\Framework\Assert::fail($scenario . ' was accepted by the public row insertion');
            } catch (\Polyspec\Orm\OrmException $error) {
                \PHPUnit\Framework\Assert::assertSame(\Polyspec\Orm\Code::ROW_MUTATION_UNSUPPORTED, $error->code_);
            }
            \PHPUnit\Framework\Assert::assertNotContains(true, array_map(static fn (string $query): bool => str_starts_with($query, 'INSERT INTO'), $pdo->queries));
            if ($partialRevokes === 1) {
                \PHPUnit\Framework\Assert::assertNotContains('SELECT CURRENT_USER()', $pdo->queries);
            } else {
                \PHPUnit\Framework\Assert::assertContains(true, array_map(
                    static fn (string $query): bool => str_contains($query, 'information_schema.USER_PRIVILEGES'),
                    $pdo->queries,
                ));
            }
        }
    }
}
