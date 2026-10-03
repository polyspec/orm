<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * The diff of a plan, shared by Dbspec::diff and the plan statements
 * (docs/plans.md "Diff").
 *
 * @internal
 */
final class PlanDiff
{
    /** @var array<string, Table> 이름: source table */
    public array $source = [];
    /** @var array<string, Table> 이름: target table */
    public array $target = [];
    /** @var array<string, string> target table: source table */
    public array $tableOf = [];
    /** @var array<string, array<string, string>> target table: target column: source column */
    public array $columnOf = [];
    /** @var list<string> */
    public array $created = [];
    /** @var list<string> source 이름 순 */
    public array $dropped = [];
    /** @var list<string> target 이름 순 */
    public array $matched = [];
    /** @var array<string, list<string>> target table: 더한 target column */
    public array $added = [];
    /** @var array<string, list<string>> target table: 지운 source column */
    public array $removed = [];
    /** @var array<string, list<string>> target table: 바꾼 target column */
    public array $altered = [];
    /** @var list<TableRename> */
    public array $renamedTables = [];
    /** @var list<ColumnRename> */
    public array $renamedColumns = [];
    /** @var array<string, list<array{0: string, 1: string}>> source table: 지울 [kind, name] */
    public array $dropObjects = [];
    /** @var array<string, list<array{0: string, 1: string}>> target table: 더할 [kind, name] */
    public array $addObjects = [];
    /** @var array<string, true> target table: trigger 가 바뀐다 */
    public array $triggers = [];
    /** @var list<Change> */
    public array $changes = [];
    /** @var array<string, string> source table: target table */
    public array $renamedFrom = [];
    /** @var array<string, array<string, string>> target table: source column: target column */
    public array $renamedColumn = [];

    private function __construct()
    {
    }

    /**
     * source(null 이면 빈 schema)에서 plan 의 target 으로 가는 diff, 또는
     * diagnostic. source 의 schemaHash 가 plan 의 from 과 다르면 diagnostic 이다.
     *
     * @return array{0: ?self, 1: list<Diagnostic>}
     */
    public static function of(?Document $source, Plan $plan): array
    {
        $from = null;
        if ($source !== null) {
            $manifest = Dbspec::manifest([$source]);
            if ($manifest->manifest === null) {
                return [null, $manifest->diagnostics];
            }
            $from = $manifest->manifest->schemaHash;
        }
        if ($from !== $plan->from) {
            return [null, [self::error('the plan starts from ' . ($plan->from ?? 'empty') . ', and the source schema is ' . ($from ?? 'empty'))]];
        }
        $d = new self();
        foreach ($source?->tables ?? [] as $table) {
            $d->source[$table->name] = $table;
        }
        foreach ($plan->schema->tables as $table) {
            $d->target[$table->name] = $table;
        }
        $out = [];
        // table rename
        foreach (PlanText::sortedBy($plan->renameTables, static fn(TableRename $r): string => $r->old) as $r) {
            if (!isset($d->source[$r->old])) {
                $out[] = self::error("rename table {$r->old}: the source has no table {$r->old}");
            } elseif (isset($d->source[$r->new])) {
                $out[] = self::error("rename table {$r->old}: the source already has a table {$r->new}");
            } elseif (!isset($d->target[$r->new])) {
                $out[] = self::error("rename table {$r->old}: the target has no table {$r->new}");
            } else {
                $d->renamedFrom[$r->old] = $r->new;
                $d->renamedTables[] = $r;
            }
        }
        foreach (self::sortedKeys($d->source) as $name) {
            $t = $d->renamedFrom[$name] ?? $name;
            if (isset($d->target[$t])) {
                $d->tableOf[$t] = $name;
            } else {
                $d->dropped[] = $name;
            }
        }
        foreach (self::sortedKeys($d->target) as $name) {
            if (isset($d->tableOf[$name])) {
                $d->matched[] = $name;
            } else {
                $d->created[] = $name;
            }
        }
        // table drop permission
        $allowedTables = [];
        foreach ($plan->dropTables as $t) {
            $allowedTables[$t] = true;
            if (!in_array($t, $d->dropped, true)) {
                $out[] = self::error("allow drop table $t drops nothing");
            }
        }
        foreach ($d->dropped as $t) {
            if (!isset($allowedTables[$t])) {
                $out[] = self::error("table $t is dropped without allow drop table $t");
            }
        }
        // column rename
        foreach (PlanText::sortedBy($plan->renameColumns, static fn(ColumnRename $r): string => "{$r->table}.{$r->old}") as $r) {
            $src = $d->tableOf[$r->table] ?? null;
            if ($src === null) {
                $out[] = self::error("rename column {$r->table}.{$r->old}: {$r->table} is not a table of both schemas");
            } elseif (self::column($d->source[$src], $r->old) === null) {
                $out[] = self::error("rename column {$r->table}.{$r->old}: the source table has no column {$r->old}");
            } elseif (self::column($d->source[$src], $r->new) !== null) {
                $out[] = self::error("rename column {$r->table}.{$r->old}: the source table already has a column {$r->new}");
            } elseif (self::column($d->target[$r->table], $r->new) === null) {
                $out[] = self::error("rename column {$r->table}.{$r->old}: the target table has no column {$r->new}");
            } else {
                $d->renamedColumn[$r->table][$r->old] = $r->new;
                $d->renamedColumns[] = $r;
            }
        }
        $allowedColumns = [];
        foreach ($plan->dropColumns as $c) {
            $allowedColumns["{$c->table}.{$c->name}"] = true;
        }
        $usedColumnPermissions = [];
        // matched table 의 column
        foreach ($d->matched as $name) {
            $src = $d->source[$d->tableOf[$name]];
            $tgt = $d->target[$name];
            $renamed = $d->renamedColumn[$name] ?? [];
            $d->columnOf[$name] = [];
            foreach ($src->columns as $c) {
                $n = $renamed[$c->name] ?? $c->name;
                if (self::column($tgt, $n) === null) {
                    $ref = "{$src->name}.{$c->name}";
                    if (!isset($allowedColumns[$ref])) {
                        $out[] = self::error("column $ref is dropped without allow drop column $ref");
                    }
                    $usedColumnPermissions[$ref] = true;
                    $d->removed[$name][] = $c->name;
                    continue;
                }
                $d->columnOf[$name][$n] = $c->name;
            }
            foreach ($tgt->columns as $c) {
                $old = $d->columnOf[$name][$c->name] ?? null;
                if ($old === null) {
                    if (!$c->nullable && $c->default === null) {
                        $out[] = self::error("column $name.{$c->name} is added non-null without a default; add it null, fill it, and make it non-null in a later plan");
                    }
                    if ($c->identity) {
                        $out[] = self::error("column $name.{$c->name} adds an identity, which changes the primary key");
                    }
                    $d->added[$name][] = $c->name;
                    continue;
                }
                $sc = self::column($src, $old);
                if ($sc->identity !== $c->identity) {
                    $out[] = self::error("column $name.{$c->name} changes identity; it needs a new table");
                    continue;
                }
                if (!self::sameType($sc->type, $c->type) && !self::widens($sc->type, $c->type)) {
                    $out[] = self::error("column $name.{$c->name} changes type from {$sc->type->text()} to {$c->type->text()}, which does not keep every value; it needs a new column");
                    continue;
                }
                if (!self::sameType($sc->type, $c->type) || $sc->nullable !== $c->nullable || $sc->default !== $c->default) {
                    $d->altered[$name][] = $c->name;
                }
            }
            // PostgreSQL 은 column 자리를 정하지 못하므로 남는 column 의 순서는 그대로이고
            // 더한 column 은 남는 column 뒤에 온다.
            $kept = [];
            foreach ($src->columns as $c) {
                $n = $renamed[$c->name] ?? $c->name;
                if (self::column($tgt, $n) !== null) {
                    $kept[] = $n;
                }
            }
            $keptTarget = [];
            $lastKept = -1;
            foreach ($tgt->columns as $i => $c) {
                if (isset($d->columnOf[$name][$c->name])) {
                    $keptTarget[] = $c->name;
                    $lastKept = $i;
                }
            }
            if ($kept !== $keptTarget) {
                $out[] = self::error("table $name reorders its columns; columns keep their order");
            }
            foreach ($tgt->columns as $i => $c) {
                if (!isset($d->columnOf[$name][$c->name]) && $i < $lastKept) {
                    $out[] = self::error("column $name.{$c->name} is added before a kept column; added columns come last");
                }
            }
            $sourceKey = array_map(static fn(string $k): string => $renamed[$k] ?? $k, $src->primaryKey->columns);
            if ($sourceKey !== $tgt->primaryKey->columns) {
                $out[] = self::error("table $name changes its primary key; it needs a new table");
            }
        }
        foreach ($plan->dropColumns as $c) {
            if (!isset($usedColumnPermissions["{$c->table}.{$c->name}"])) {
                $out[] = self::error("allow drop column {$c->table}.{$c->name} drops nothing");
            }
        }
        if ($out !== []) {
            return [null, $out];
        }
        PlanObjects::compare($d);
        $d->triggerChanges();
        $d->collectChanges();
        return [$d, []];
    }

    /** 세 database 에서 모든 값을 지키는 type 변경인지 알려 준다. */
    public static function widens(ColumnType $from, ColumnType $to): bool
    {
        $f = $from->parameters;
        $t = $to->parameters;
        return match ($from->name) {
            'i16' => $to->name === 'i32' || $to->name === 'i64',
            'i32' => $to->name === 'i64',
            'varchar' => ($to->name === 'varchar' && $t[0] >= $f[0]) || $to->name === 'text',
            'decimal' => $to->name === 'decimal' && $t[1] === $f[1] && $t[0] >= $f[0],
            'time', 'datetime' => $to->name === $from->name && $t[0] >= $f[0],
            default => false,
        };
    }

    public static function sameType(ColumnType $a, ColumnType $b): bool
    {
        return $a->name === $b->name && $a->parameters === $b->parameters;
    }

    public static function column(Table $t, string $name): ?Column
    {
        foreach ($t->columns as $c) {
            if ($c->name === $name) {
                return $c;
            }
        }
        return null;
    }

    public static function hasTriggers(Table $t): bool
    {
        foreach ($t->settings?->settings ?? [] as $setting) {
            if ($setting->kind === 'immutable' || $setting->kind === 'audit') {
                return true;
            }
        }
        return false;
    }

    /**
     * 이름 key 를 byte 순서로 돌려준다.
     *
     * @param array<string, mixed> $map
     * @return list<string>
     */
    public static function sortedKeys(array $map): array
    {
        $keys = array_map('strval', array_keys($map));
        usort($keys, strcmp(...));
        return $keys;
    }

    /**
     * 세 dialect 중 하나에서라도 렌더링한 trigger statement 가 다른 table 을
     * 표시한다. source 는 rename 을 적용하기 전 이름 그대로 렌더링한다.
     */
    private function triggerChanges(): void
    {
        foreach ($this->matched as $name) {
            $src = $this->source[$this->tableOf[$name]];
            $tgt = $this->target[$name];
            foreach (Renderer::DIALECTS as $dialect) {
                $r = new Renderer($dialect);
                if ($r->triggers($src) !== $r->triggers($tgt)) {
                    $this->triggers[$name] = true;
                    break;
                }
            }
        }
    }

    private function collectChanges(): void
    {
        $add = function (string $kind, string $table, string $name): void {
            $this->changes[] = new Change($kind, $table, $name);
        };
        foreach ($this->matched as $name) {
            if (isset($this->triggers[$name]) && self::hasTriggers($this->source[$this->tableOf[$name]])) {
                $add('drop_triggers', $this->tableOf[$name], '');
            }
        }
        foreach (self::sortedKeys($this->dropObjects) as $s) {
            foreach ($this->dropObjects[$s] as [$kind, $object]) {
                $add("drop_$kind", $s, $object);
            }
        }
        foreach (PlanText::sortedBy($this->renamedTables, static fn(TableRename $r): string => $r->old) as $r) {
            $add('rename_table', $r->old, $r->new);
        }
        foreach (PlanText::sortedBy($this->renamedColumns, static fn(ColumnRename $r): string => "{$r->table}.{$r->old}") as $r) {
            $add('rename_column', $r->table, "{$r->old} {$r->new}");
        }
        foreach ($this->matched as $name) {
            foreach ($this->removed[$name] ?? [] as $c) {
                $add('drop_column', $this->tableOf[$name], $c);
            }
        }
        foreach ($this->dropped as $name) {
            $add('drop_table', $name, '');
        }
        foreach ($this->created as $name) {
            $add('create_table', $name, '');
        }
        foreach ($this->matched as $name) {
            foreach ($this->added[$name] ?? [] as $c) {
                $add('add_column', $name, $c);
            }
            foreach ($this->altered[$name] ?? [] as $c) {
                $add('alter_column', $name, $c);
            }
        }
        foreach (self::sortedKeys($this->addObjects) as $t) {
            foreach ($this->addObjects[$t] as [$kind, $object]) {
                $add("add_$kind", $t, $object);
            }
        }
        foreach ($this->matched as $name) {
            if (isset($this->triggers[$name]) && self::hasTriggers($this->target[$name])) {
                $add('create_triggers', $name, '');
            }
        }
    }

    private static function error(string $message): Diagnostic
    {
        return new Diagnostic('plan', 1, 1, $message);
    }
}
