<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

final class CatalogPageMutationPdo extends UninitializedRecordingPdo
{
    private int $columnReads = 0;

    public function __construct(public readonly string $scenario)
    {
    }

    public function prepare(string $query, array $options = []): \PDOStatement|false
    {
        return new CatalogPageMutationStatement($this, $query);
    }

    /** @return array{columns: list<array{name: string, native_type: string}>, rows: list<list<mixed>>} */
    public function resultFor(string $query): array
    {
        if (str_starts_with($query, 'SELECT type FROM pragma_table_list')) {
            return ['columns' => [['name' => 'type', 'native_type' => 'TEXT']], 'rows' => [['table']]];
        }
        if (str_starts_with($query, 'SELECT name,type,NOT "notnull"')) {
            $this->columnReads++;
            $nativeType = $this->scenario === 'descriptor' && $this->columnReads > 1 ? 'BLOB' : 'TEXT';
            return [
                'columns' => array_map(
                    static fn (string $name): array => ['name' => $name, 'native_type' => 'TEXT'],
                    [
                        'name',
                        'type',
                        'nullable',
                        'generated',
                        'key_order',
                        'automatic_key',
                        'default_expression',
                        'expression_default',
                    ]
                ),
                'rows' => [['id', $nativeType, 1, 0, 0, 0, null, 0]],
            ];
        }
        if (str_starts_with($query, 'SELECT "id" FROM "main"."page_probe"')) {
            $name = $this->scenario === 'prepared' ? 'renamed' : 'id';
            return ['columns' => [['name' => $name, 'native_type' => 'TEXT']], 'rows' => []];
        }
        throw new \RuntimeException("unexpected catalog page query: {$query}");
    }
}
