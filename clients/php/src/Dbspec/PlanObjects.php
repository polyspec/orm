<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Compares the unique keys, indexes, foreign keys and checks of a plan's
 * matched tables by name and definition (docs/plans.md "Diff"). A source
 * definition is read with the renames applied, in target names.
 *
 * @internal
 */
final class PlanObjects
{
    // canonical check text 의 token: 문자열 literal, 이름이나 숫자, 그 밖의 한 글자.
    private const CHECK_TOKEN = "/'(?:[^']|'')*'|[A-Za-z0-9_]+|./s";
    private const KEYWORDS = ['and' => true, 'or' => true, 'not' => true, 'in' => true, 'between' => true, 'is' => true, 'null' => true, 'true' => true, 'false' => true];

    public static function compare(PlanDiff $d): void
    {
        $alteredColumn = []; // "table.column" target 이름
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
        // column rename 을 적용한 source 이름
        $column = static fn(string $target, string $c): string => $d->renamedColumn[$target][$c] ?? $c;
        $same = static fn(string $c): string => $c;
        foreach ($d->matched as $name) {
            $src = $d->source[$d->tableOf[$name]];
            $tgt = $d->target[$name];
            $renamed = static fn(string $c): string => $column($name, $c);
            // 지우는 index 나 unique 위의 foreign key 는 MySQL 이 그 index 를 지우지
            // 못하게 하므로 함께 다시 만든다.
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
                    $droppedKeys[implode(',', array_map(static fn(IndexColumn $c): string => $renamed($c->name), $x->columns))] = true;
                }
            }
            foreach ($tgt->indexes as $x) {
                $s = self::named($src->indexes, $x->name);
                if ($s === null || self::indexDef($s, $renamed) !== self::indexDef($x, $same)) {
                    $d->addObjects[$name][] = ['index', $x->name];
                }
            }
            // foreign key
            $forcedFK = static function (array $cols, string $parent, array $refs) use ($alteredColumn, $droppedKeys, $name): bool {
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
            // source foreign key 를 target 이름으로 읽은 [columns, parent, references]
            $sourceForeignKey = static function (ForeignKey $f) use ($targetTable, $column, $renamed): array {
                $parent = $targetTable($f->table);
                return [array_map($renamed, $f->columns), $parent, array_map(static fn(string $c): string => $column($parent, $c), $f->referencedColumns)];
            };
            foreach ($src->foreignKeys as $f) {
                [$cols, $parent, $refs] = $sourceForeignKey($f);
                $t = self::named($tgt->foreignKeys, $f->name);
                if ($t === null || self::foreignKeyDef($cols, $parent, $refs, $f) !== self::foreignKeyDef($t->columns, $t->table, $t->referencedColumns, $t) || $forcedFK($cols, $parent, $refs)) {
                    $d->dropObjects[$src->name][] = ['foreign_key', $f->name];
                }
            }
            foreach ($tgt->foreignKeys as $f) {
                $s = self::named($src->foreignKeys, $f->name);
                $keep = false;
                if ($s !== null) {
                    [$cols, $parent, $refs] = $sourceForeignKey($s);
                    $keep = self::foreignKeyDef($cols, $parent, $refs, $s) === self::foreignKeyDef($f->columns, $f->table, $f->referencedColumns, $f) && !$forcedFK($cols, $parent, $refs);
                }
                if (!$keep) {
                    $d->addObjects[$name][] = ['foreign_key', $f->name];
                }
            }
            // check: 이름 바뀐 column 이나 바뀐 column 을 쓰는 check 는 다시 만든다.
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
        // 지우는 table 을 참조하는 남은 table 의 foreign key 는 target 이 이미 뺐으므로
        // 위에서 지운다. 지우는 table 자신의 foreign key 는 table 과 함께 지운다.
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
     * 이름이 같은 객체.
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
     * canonical check text 가 쓰는 column 이름.
     *
     * @return list<string>
     */
    private static function checkColumns(string $expression): array
    {
        preg_match_all(self::CHECK_TOKEN, $expression, $m);
        return array_values(array_filter($m[0], self::isColumn(...)));
    }

    /**
     * column 이름을 f 로 바꾼 canonical check text.
     *
     * @param callable(string): string $f
     */
    private static function checkText(string $expression, callable $f): string
    {
        return preg_replace_callback(self::CHECK_TOKEN, static fn(array $m): string => self::isColumn($m[0]) ? $f($m[0]) : $m[0], $expression)
            ?? throw new \LogicException("Check text `$expression` cannot be read");
    }

    /** 문자열, 숫자와 keyword 가 아닌 이름 token 은 column 이다. */
    private static function isColumn(string $token): bool
    {
        return preg_match('/^[a-z][a-z0-9_]*$/D', $token) === 1 && !isset(self::KEYWORDS[$token]);
    }
}
