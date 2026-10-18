<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * One table of the introspection's neutral intermediate model. type is a ColumnType, and
 * the default literals and predicates are already in dbspec notation.
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
    /** @var list<string> Lines of the settings block */
    public array $settings = [];

    public function __construct(public readonly string $name)
    {
    }

    /** column name: type. @return array<string, ColumnType> */
    public function columnTypes(): array
    {
        $out = [];
        foreach ($this->columns as $column) {
            $out[$column['name']] = $column['type'];
        }
        return $out;
    }

    /** Removes columns whose type is undetermined. */
    public function dropColumn(string $name): void
    {
        $this->columns = array_values(array_filter($this->columns, static fn(array $c): bool => $c['name'] !== $name));
    }
}
