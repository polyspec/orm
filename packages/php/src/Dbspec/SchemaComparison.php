<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Lists all differences between two schemas without a plan (docs/spec/plans.md "Comparison"). Since there is no
 * rename, tables and columns are matched by name only.
 *
 * @internal
 */
final class SchemaComparison
{
    /** The order in which differences come within one table. */
    private const KINDS = [
        'create_table', 'drop_table',
        'drop_column', 'add_column', 'alter_column', 'change_column_type', 'change_column_identity',
        'reorder_columns', 'change_primary_key',
        'drop_unique', 'add_unique', 'drop_index', 'add_index',
        'drop_foreign_key', 'add_foreign_key', 'drop_check', 'add_check',
        'drop_immutable', 'add_immutable', 'drop_audit', 'add_audit',
    ];

    private function __construct()
    {
    }

    public static function compare(Document $source, Document $target): ComparisonResult
    {
        $diagnostics = [];
        foreach (['source' => $source, 'target' => $target] as $side => $document) {
            if (!self::isSchemaText($document)) {
                $diagnostics[] = new Diagnostic(
                    'compare',
                    1,
                    1,
                    "the $side is not a schema text: one document named schema in canonical form with its "
                    . "tables in name order and only the immutable and audit settings"
                );
            }
        }
        if ($diagnostics !== []) {
            return ComparisonResult::invalid($diagnostics);
        }
        $sourceTables = [];
        foreach ($source->tables as $t) {
            $sourceTables[$t->name] = $t;
        }
        $targetTables = [];
        foreach ($target->tables as $t) {
            $targetTables[$t->name] = $t;
        }
        $rank = array_flip(self::KINDS);
        $differences = [];
        foreach (PlanDiff::sortedKeys($sourceTables + $targetTables) as $name) {
            $found = [];
            $add = static function (string $kind, string $n) use (&$found, $name): void {
                $found[] = new Difference($kind, $name, $n);
            };
            $s = $sourceTables[$name] ?? null;
            $t = $targetTables[$name] ?? null;
            if ($s === null) {
                $add('create_table', '');
            } elseif ($t === null) {
                $add('drop_table', '');
            } else {
                self::tables($s, $t, $add);
            }
            usort($found, static fn(Difference $a, Difference $b): int =>
                ($rank[$a->kind] <=> $rank[$b->kind]) ?: strcmp($a->name, $b->name));
            array_push($differences, ...$found);
        }
        return ComparisonResult::valid($differences);
    }

    /**
     * Tells whether the canonical emission of the document is that one document's schema text. The use
     * lines of external documents are in document name order, and the tables in name order. The external
     * document itself is not needed.
     *
     * @internal PlanText also uses it.
     */
    public static function isSchemaText(Document $document): bool
    {
        if ($document->name !== 'schema') {
            return false;
        }
        $schema = new Document('schema');
        $schema->tables = $document->tables;
        usort($schema->tables, static fn(Table $a, Table $b): int => strcmp($a->name, $b->name));
        foreach ($document->uses as $use) {
            $tables = array_values(array_unique($use->tables));
            sort($tables, SORT_STRING);
            $schema->uses[] = new UseLine($use->document, $tables);
        }
        return Dbspec::emit($document) === Emitter::emit($schema, View::Schema);
    }

    /**
     * Adds the differences in columns, primary key, objects, and settings of tables present on both sides.
     *
     * @param \Closure(string, string): void $add
     */
    private static function tables(Table $s, Table $t, \Closure $add): void
    {
        foreach ($s->columns as $c) {
            if (PlanDiff::column($t, $c->name) === null) {
                $add('drop_column', $c->name);
            }
        }
        $keptTarget = [];
        $lastKept = -1;
        $firstAdded = -1;
        foreach ($t->columns as $i => $c) {
            $sc = PlanDiff::column($s, $c->name);
            if ($sc === null) {
                $add('add_column', $c->name);
                if ($firstAdded < 0) {
                    $firstAdded = $i;
                }
                continue;
            }
            $keptTarget[] = $c->name;
            $lastKept = $i;
            $sameType = PlanDiff::sameType($sc->type, $c->type);
            if (
                (!$sameType && PlanDiff::widens($sc->type, $c->type)) || $sc->nullable !== $c->nullable
                || $sc->default !== $c->default
            ) {
                $add('alter_column', $c->name);
            }
            if (!$sameType && !PlanDiff::widens($sc->type, $c->type)) {
                $add('change_column_type', $c->name);
            }
            if ($sc->identity !== $c->identity) {
                $add('change_column_identity', $c->name);
            }
        }
        $kept = [];
        foreach ($s->columns as $c) {
            if (PlanDiff::column($t, $c->name) !== null) {
                $kept[] = $c->name;
            }
        }
        if ($kept !== $keptTarget || ($firstAdded >= 0 && $firstAdded < $lastKept)) {
            $add('reorder_columns', '');
        }
        if (($s->primaryKey?->columns ?? []) !== ($t->primaryKey?->columns ?? [])) {
            $add('change_primary_key', '');
        }
        $same = static fn(string $c): string => $c;
        self::objects(
            $add,
            'unique',
            $s->uniqueKeys,
            $t->uniqueKeys,
            static fn(UniqueKey $u): string => implode(',', $u->columns)
        );
        self::objects(
            $add,
            'index',
            $s->indexes,
            $t->indexes,
            static fn(Index $x): string => PlanObjects::indexDef($x, $same)
        );
        self::objects(
            $add,
            'foreign_key',
            $s->foreignKeys,
            $t->foreignKeys,
            static fn(ForeignKey $f): string =>
            PlanObjects::foreignKeyDef($f->columns, $f->table, $f->referencedColumns, $f)
        );
        self::objects($add, 'check', $s->checks, $t->checks, static fn(Check $k): string => $k->expression);
        foreach (['immutable', 'audit'] as $kind) {
            $sourceSetting = self::setting($s, $kind, $s, $t);
            $targetSetting = self::setting($t, $kind, $s, $t);
            if ($sourceSetting !== $targetSetting) {
                if ($sourceSetting !== null) {
                    $add("drop_$kind", '');
                }
                if ($targetSetting !== null) {
                    $add("add_$kind", '');
                }
            }
        }
    }

    /**
     * Objects matched by name: if only on one side, adds a drop or an add; if the definitions differ, adds both.
     *
     * @template T of object
     * @param \Closure(string, string): void $add
     * @param list<T> $source
     * @param list<T> $target
     * @param \Closure(T): string $def
     */
    private static function objects(\Closure $add, string $kind, array $source, array $target, \Closure $def): void
    {
        foreach ($source as $o) {
            $other = PlanObjects::named($target, $o->name);
            if ($other === null || $def($other) !== $def($o)) {
                $add("drop_$kind", $o->name);
            }
        }
        foreach ($target as $o) {
            $other = PlanObjects::named($source, $o->name);
            if ($other === null || $def($other) !== $def($o)) {
                $add("add_$kind", $o->name);
            }
        }
    }

    /** The definition of a setting that a table has only one of; null if none. */
    /**
     * The definition of the table's single setting, or null if none. Among the columns on both sides, audit
     * compares even the columns it does not record. A column on only one side becomes an add_column or drop_column
     * difference.
     */
    private static function setting(Table $x, string $kind, Table $s, Table $t): ?string
    {
        foreach ($x->settings?->settings ?? [] as $setting) {
            if ($setting->kind !== $kind) {
                continue;
            }
            $def = $setting->arguments;
            if ($kind === 'audit') {
                foreach ($t->columns as $column) {
                    if (PlanDiff::column($s, $column->name) !== null && !$setting->records($column->name)) {
                        $def[] = $column->name;
                    }
                }
            }
            return implode(' ', $def);
        }
        return null;
    }
}
