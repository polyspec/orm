<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The neutral intermediate model that the dialect reader fills. document() turns it into the dbspec
 * document (docs/spec/dialects.md "Introspection").
 *
 * @internal
 */
final class Catalog
{
    /** @var list<CatalogTable> */
    public array $tables = [];
    /** @var list<Unsupported> */
    public array $unsupported = [];

    /** @var array<string, ColumnType> One ColumnType per type text */
    private array $types = [];

    /**
     * The ColumnType of the same type is shared as one. ColumnType is readonly, so
     * sharing it is safe, and it cuts tens of thousands of objects in a catalog of 2000 tables.
     */
    public function sharedType(ColumnType $type): ColumnType
    {
        return $this->types[$type->text()] ??= $type;
    }

    public function report(string $kind, string $table, string $name, string $reason): void
    {
        $this->unsupported[] = new Unsupported($kind, $table, $name, $reason);
    }

    public function table(string $name): ?CatalogTable
    {
        foreach ($this->tables as $table) {
            if ($table->name === $name) {
                return $table;
            }
        }
        return null;
    }

    /**
     * Writes the intermediate model as dbspec text and parses it. If parse rejects a line,
     * that line's object is reported as unsupported and removed, and the text is rebuilt. An object that
     * referred to a removed object is rejected by the next parse, so it is removed the same way. A
     * diagnostic on a line that belongs to no object is a defect of the reader, so it is an error.
     */
    public function document(string $name): IntrospectResult
    {
        $this->dropTablesWithoutKey();
        while (true) {
            [$text, $objects] = $this->text($name);
            $result = Dbspec::parse($text, []);
            if ($result->document !== null) {
                $unsupported = $this->unsupported;
                usort($unsupported, static fn(Unsupported $a, Unsupported $b): int => strcmp(
                    "{$a->table}\0{$a->kind}\0{$a->name}",
                    "{$b->table}\0{$b->kind}\0{$b->name}"
                ));
                return new IntrospectResult($result->document, $unsupported);
            }
            // Objects of a rejected table are removed together with the table, so they are not reported separately.
            $rejected = [];
            foreach ($result->diagnostics as $d) {
                $packed = $objects[$d->line] ?? null;
                if ($packed === null) {
                    $found = implode("\n", array_map(
                        static fn(Diagnostic $x): string => "{$x->line}:{$x->column} {$x->rule} {$x->message}",
                        $result->diagnostics
                    ));
                    throw new \RuntimeException("Introspected document does not parse:\n$found\n$text");
                }
                $object = explode("\0", $packed);
                if ($object[0] === 'table') {
                    $rejected[$object[1]] = true;
                }
            }
            $removed = [];
            foreach ($result->diagnostics as $d) {
                $object = explode("\0", $objects[$d->line]);
                if ($object[0] !== 'table' && isset($rejected[$object[1]])) {
                    continue;
                }
                $key = implode("\0", $object);
                if (!isset($removed[$key])) {
                    $removed[$key] = true;
                    $this->report($object[0], $object[1], $object[2], "{$d->rule}: {$d->message}");
                    $this->remove($object);
                }
            }
        }
    }

    /**
     * Removes one object. Removing a table or its primary key removes the whole table.
     *
     * @param array{0: string, 1: string, 2: string} $object kind, table, name
     */
    private function remove(array $object): void
    {
        [$kind, $tableName, $name] = $object;
        $t = $this->table($tableName);
        $without = static fn(array $items): array => array_values(
            array_filter($items, static fn(array $x): bool => $x['name'] !== $name)
        );
        match ($kind) {
            'table' => $this->tables = array_values(
                array_filter($this->tables, static fn(CatalogTable $x): bool => $x !== $t)
            ),
            'column' => $t->columns = $without($t->columns),
            'unique' => $t->uniques = $without($t->uniques),
            'index' => $t->indexes = $without($t->indexes),
            'foreign_key' => $t->foreignKeys = $without($t->foreignKeys),
            'check' => $t->checks = $without($t->checks),
            'trigger' => $t->settings = array_values(array_filter(
                $t->settings,
                static fn(string $s): bool => self::firstWord($s) !== $name
            )),
        };
    }

    /**
     * Removes a table without a primary key. A foreign key that referred to that table is rejected by parse,
     * so it is removed too.
     */
    private function dropTablesWithoutKey(): void
    {
        $kept = [];
        foreach ($this->tables as $t) {
            if ($t->primary === []) {
                $this->report('table', $t->name, $t->name, 'the table has no primary key');
                continue;
            }
            $kept[] = $t;
        }
        $this->tables = $kept;
    }

    /**
     * Returns the dbspec text with the tables written in name order, and for each line number, the object on that line
     * is returned. The closing brace and the primary key line belong to the table.
     *
     * @return array{0: string, 1: array<int, string>} The text, and for each line number, "kind\0table\0name"
     */
    private function text(string $name): array
    {
        $tables = $this->tables;
        usort($tables, static fn(CatalogTable $a, CatalogTable $b): int => strcmp($a->name, $b->name));
        $lines = ["dbspec 1 $name"];
        $objects = [];
        // An object on a line is kept as a "kind\0table\0name" string. It is smaller than an array, so in a
        // large catalog
        // it reduces memory.
        $add = static function (string $line, array $object) use (&$lines, &$objects): void {
            $lines[] = $line;
            $objects[count($lines)] = implode("\0", $object);
        };
        foreach ($tables as $t) {
            $table = ['table', $t->name, $t->name];
            $lines[] = '';
            $add("table {$t->name} {", $table);
            foreach ($t->columns as $c) {
                $s = "  {$c['name']} " . $c['type']->text();
                if ($c['null']) {
                    $s .= ' null';
                }
                if ($c['identity']) {
                    $s .= ' identity';
                }
                if ($c['default'] !== '') {
                    $s .= " default {$c['default']}";
                }
                $add($s, ['column', $t->name, $c['name']]);
            }
            $add('  primary key (' . implode(', ', $t->primary) . ')', $table);
            foreach ($t->uniques as $u) {
                $add("  unique {$u['name']} (" . implode(', ', $u['columns']) . ')', ['unique', $t->name, $u['name']]);
            }
            foreach ($t->indexes as $x) {
                $columns = [];
                foreach ($x['columns'] as $i => $column) {
                    $columns[] = $column . ($x['desc'][$i] ? ' desc' : '');
                }
                $add("  index {$x['name']} (" . implode(', ', $columns) . ')', ['index', $t->name, $x['name']]);
            }
            foreach ($t->foreignKeys as $f) {
                $add(
                    "  foreign key {$f['name']} (" . implode(', ', $f['columns'])
                    . ") references {$f['table']} (" . implode(', ', $f['refs'])
                    . ") on delete {$f['onDelete']} on update {$f['onUpdate']}",
                    ['foreign_key', $t->name, $f['name']]
                );
            }
            foreach ($t->checks as $k) {
                $add("  check {$k['name']} ({$k['predicate']})", ['check', $t->name, $k['name']]);
            }
            if ($t->settings !== []) {
                $add('  settings {', $table);
                foreach ($t->settings as $s) {
                    $add("    $s", ['trigger', $t->name, self::firstWord($s)]);
                }
                $add('  }', $table);
            }
            $add('}', $table);
        }
        return [implode("\n", $lines) . "\n", $objects];
    }

    private static function firstWord(string $line): string
    {
        return explode(' ', $line, 2)[0];
    }

    /** Converts a catalog reference action to a dbspec action. null if there is none. */
    public static function actionName(string $rule): ?string
    {
        return match (strtoupper($rule)) {
            'RESTRICT' => 'restrict',
            'CASCADE' => 'cascade',
            'SET NULL' => 'set_null',
            default => null,
        };
    }

    /** Writes the integer text multiplied by 10^scale as a decimal with scale digits. */
    public static function unscaledDecimal(string $text, int $scale): string
    {
        $negative = str_starts_with($text, '-');
        $digits = $negative ? substr($text, 1) : $text;
        if ($scale > 0) {
            if (strlen($digits) <= $scale) {
                $digits = str_repeat('0', $scale - strlen($digits) + 1) . $digits;
            }
            $digits = substr($digits, 0, -$scale) . '.' . substr($digits, -$scale);
        }
        return ($negative ? '-' : '') . $digits;
    }
}
