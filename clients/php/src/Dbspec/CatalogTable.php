<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * introspection 의 중립 중간 model 에서 table 하나. type 은 ColumnType 이고,
 * default literal 과 predicate 는 이미 dbspec 표기다.
 *
 * @internal
 */
final class CatalogTable
{
    /** @var list<array{name: string, type: ColumnType, null: bool, identity: bool, default: string}> */
    public array $columns = [];
    /** @var list<string> */
    public array $primary = [];
    /** @var list<array{name: string, columns: list<string>, desc: list<bool>}> */
    public array $uniques = [];
    /** @var list<array{name: string, columns: list<string>, desc: list<bool>}> */
    public array $indexes = [];
    /** @var list<array{name: string, columns: list<string>, table: string, refs: list<string>, onDelete: string, onUpdate: string}> */
    public array $foreignKeys = [];
    /** @var list<array{name: string, predicate: string}> */
    public array $checks = [];
    /** @var list<string> settings 블록의 줄 */
    public array $settings = [];

    public function __construct(public readonly string $name)
    {
    }

    /** column 이름: type. @return array<string, ColumnType> */
    public function columnTypes(): array
    {
        $out = [];
        foreach ($this->columns as $column) {
            $out[$column['name']] = $column['type'];
        }
        return $out;
    }

    /** type 이 정해지지 않은 column 을 뺀다. */
    public function dropColumn(string $name): void
    {
        $this->columns = array_values(array_filter($this->columns, static fn(array $c): bool => $c['name'] !== $name));
    }
}
