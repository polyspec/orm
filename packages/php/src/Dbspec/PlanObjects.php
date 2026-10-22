<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Compares the unique keys, indexes, foreign keys and checks of a plan's
 * matched tables by name and definition (docs/spec/plans.md "Diff"). A source
 * definition is read with the renames applied, in target names.
 *
 * @internal
 */
final class PlanObjects
{
    // Token of canonical check text: a string literal, a name or number, or any other single character.
    private const CHECK_TOKEN = "/'(?:[^']|'')*'|[A-Za-z0-9_]+|./s";
    private const KEYWORDS = [
        'and' => true, 'or' => true, 'not' => true, 'in' => true, 'between' => true, 'is' => true,
        'null' => true, 'true' => true, 'false' => true
    ];

    public static function compare(PlanDiff $d): void
    {
        $alteredColumn = []; // The target name "table.column"
        foreach ($d->altered as $t => $columns) {
            foreach ($columns as $c) {
                $alteredColumn["$t.$c"] = true;
            }
        }
        $renamedCol = [];
        foreach ($d->renamedColumn as $t => $map) {
            foreach ($map as $c) {
                $renamedCol["$t.$c"] = true;
            }
        }
        $targetTable = static fn(string $s): string => $d->renamedFrom[$s] ?? $s;
        // Source name after the column rename is applied
        $column = static fn(string $target, string $c): string => $d->renamedColumn[$target][$c] ?? $c;
        $same = static fn(string $c): string => $c;
        foreach ($d->matched as $name) {
            $src = $d->source[$d->tableOf[$name]];
            $tgt = $d->target[$name];
            $renamed = static fn(string $c): string => $column($name, $c);
            // A foreign key on an index or unique that is dropped: MySQL would not let
            // the index be dropped, so it is rebuilt together.
            $droppedKeys = [];
            // unique
            foreach ($src->uniqueKeys as $u) {
                $def = implode(',', array_map($renamed, $u->columns));
                $t = self::named($tgt->uniqueKeys, $u->name);
                if ($t === null || implode(',', $t->columns) !== $def) {
                    $d->dropObjects[$src->name][] = ['unique', $u->name];
                    $droppedKeys[$def] = true;
                }
            }
            foreach ($tgt->uniqueKeys as $u) {
                $s = self::named($src->uniqueKeys, $u->name);
                if ($s === null || implode(',', array_map($renamed, $s->columns)) !== implode(',', $u->columns)) {
                    $d->addObjects[$name][] = ['unique', $u->name];
                }
            }
            // index
            foreach ($src->indexes as $x) {
                $t = self::named($tgt->indexes, $x->name);
                if ($t === null || self::indexDef($x, $renamed) !== self::indexDef($t, $same)) {
                    $d->dropObjects[$src->name][] = ['index', $x->name];
                    $droppedKeys[implode(',', array_map(
                        static fn(IndexColumn $c): string => $renamed($c->name),
                        $x->columns
                    ))] = true;
                }
            }
            foreach ($tgt->indexes as $x) {
                $s = self::named($src->indexes, $x->name);
                if ($s === null || self::indexDef($s, $renamed) !== self::indexDef($x, $same)) {
                    $d->addObjects[$name][] = ['index', $x->name];
                }
            }
            // foreign key
            $forcedFK = static function (array $cols, string $parent, array $refs)
 use ($alteredColumn, $droppedKeys, $name): bool {
                foreach ($cols as $c) {
                    if (isset($alteredColumn["$name.$c"])) {
                        return true;
                    }
                }
                foreach ($refs as $c) {
                    if (isset($alteredColumn["$parent.$c"])) {
                        return true;
                    }
                }
                foreach (array_keys($droppedKeys) as $k) {
                    if (str_starts_with("$k,", implode(',', $cols) . ',')) {
                        return true;
                    }
                }
                return false;
            };
            // Source foreign key read with target names: [columns, parent, references]
            $sourceForeignKey = static function (ForeignKey $f) use ($targetTable, $column, $renamed): array {
                $parent = $targetTable($f->table);
                return [array_map($renamed, $f->columns), $parent, array_map(
                    static fn(string $c): string => $column($parent, $c),
                    $f->referencedColumns
                )];
            };
            foreach ($src->foreignKeys as $f) {
                [$cols, $parent, $refs] = $sourceForeignKey($f);
                $t = self::named($tgt->foreignKeys, $f->name);
                if (
                    $t === null
                    || self::foreignKeyDef($cols, $parent, $refs, $f)
                        !== self::foreignKeyDef($t->columns, $t->table, $t->referencedColumns, $t)
                    || $forcedFK($cols, $parent, $refs)
                ) {
                    $d->dropObjects[$src->name][] = ['foreign_key', $f->name];
                }
            }
            foreach ($tgt->foreignKeys as $f) {
                $s = self::named($src->foreignKeys, $f->name);
                $keep = false;
                if ($s !== null) {
                    [$cols, $parent, $refs] = $sourceForeignKey($s);
                    $keep = self::foreignKeyDef($cols, $parent, $refs, $s)
                        === self::foreignKeyDef($f->columns, $f->table, $f->referencedColumns, $f)
                        && !$forcedFK($cols, $parent, $refs);
                }
                if (!$keep) {
                    $d->addObjects[$name][] = ['foreign_key', $f->name];
                }
            }
            // check: a check that uses a renamed column or a changed column is rebuilt.
            $forcedCheck = static function (Check $k) use ($renamedCol, $alteredColumn, $name): bool {
                foreach (self::checkColumns($k->expression) as $c) {
                    if (isset($renamedCol["$name.$c"]) || isset($alteredColumn["$name.$c"])) {
                        return true;
                    }
                }
                return false;
            };
            foreach ($src->checks as $k) {
                $t = self::named($tgt->checks, $k->name);
                if ($t === null || self::checkText($k->expression, $renamed) !== $t->expression || $forcedCheck($t)) {
                    $d->dropObjects[$src->name][] = ['check', $k->name];
                }
            }
            foreach ($tgt->checks as $k) {
                $s = self::named($src->checks, $k->name);
                if ($s === null || self::checkText($s->expression, $renamed) !== $k->expression || $forcedCheck($k)) {
                    $d->addObjects[$name][] = ['check', $k->name];
                }
            }
        }
        // A foreign key from a remaining table that refers to a table being dropped is already removed by the target,
        // so it is dropped above. A foreign key of the dropped table itself is dropped with the table.
        foreach ($d->dropped as $name) {
            foreach ($d->source[$name]->foreignKeys as $f) {
                $d->dropObjects[$name][] = ['foreign_key', $f->name];
            }
        }
        $byRef = static fn(array $a, array $b): int => strcmp("$a[0]\0$a[1]", "$b[0]\0$b[1]");
        foreach ($d->dropObjects as &$objects) {
            usort($objects, $byRef);
        }
        unset($objects);
        foreach ($d->addObjects as &$objects) {
            usort($objects, $byRef);
        }
        unset($objects);
    }

    /**
     * Objects with the same name.
     *
     * @template T of object
     * @param list<T> $items items with a `name`
     * @return ?T
     */
    public static function named(array $items, string $name): ?object
    {
        foreach ($items as $item) {
            if ($item->name === $name) {
                return $item;
            }
        }
        return null;
    }

    /** @param callable(string): string $f */
    public static function indexDef(Index $x, callable $f): string
    {
        $out = '';
        foreach ($x->columns as $c) {
            $out .= $f($c->name) . ($c->descending ? ' desc' : '') . ',';
        }
        return $out;
    }

    /**
     * @param list<string> $cols
     * @param list<string> $refs
     */
    public static function foreignKeyDef(array $cols, string $parent, array $refs, ForeignKey $f): string
    {
        return implode(',', $cols) . ">$parent(" . implode(',', $refs) . ")$f->onDelete/$f->onUpdate";
    }

    /**
     * The column names that canonical check text uses.
     *
     * @return list<string>
     */
    private static function checkColumns(string $expression): array
    {
        preg_match_all(self::CHECK_TOKEN, $expression, $m);
        return array_values(array_filter($m[0], self::isColumn(...)));
    }

    /**
     * The canonical check text with the column names changed by f.
     *
     * @param callable(string): string $f
     */
    public static function checkText(string $expression, callable $f): string
    {
        return preg_replace_callback(
            self::CHECK_TOKEN,
            static fn(array $m): string => self::isColumn($m[0]) ? $f($m[0]) : $m[0],
            $expression
        )
            ?? throw new \LogicException("Check text `$expression` cannot be read");
    }

    /** A string, a number, and a name token that is not a keyword is a column. */
    private static function isColumn(string $token): bool
    {
        return preg_match('/^[a-z][a-z0-9_]*$/D', $token) === 1 && !isset(self::KEYWORDS[$token]);
    }
}
