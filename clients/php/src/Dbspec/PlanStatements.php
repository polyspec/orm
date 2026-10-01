<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * Writes the statements of a plan's diff in one dialect (docs/plans.md
 * "Statements").
 *
 * @internal
 */
final class PlanStatements
{
    /** @var list<string> */
    private array $out = [];
    /** @var array<string, true> SQLite 에서 다시 만드는 target table */
    private array $rebuilt = [];

    private function __construct(private readonly PlanDiff $d, private readonly Renderer $r)
    {
    }

    /** @return list<string> */
    public static function write(PlanDiff $d, Renderer $r): array
    {
        $w = new self($d, $r);
        $w->statements();
        return $w->out;
    }

    private function add(string ...$statements): void
    {
        array_push($this->out, ...$statements);
    }

    private function q(string $name): string
    {
        return $this->r->q($name);
    }

    private function statements(): void
    {
        $d = $this->d;
        $sqlite = $this->r->dialect === 'sqlite';
        if ($sqlite) {
            foreach ($d->matched as $name) {
                if ($this->sqliteRebuilds($name)) {
                    $this->rebuilt[$name] = true;
                }
            }
        }
        // 1. trigger
        foreach ($d->matched as $name) {
            $src = $d->source[$d->tableOf[$name]];
            if (PlanDiff::hasTriggers($src) && (isset($d->triggers[$name]) || isset($this->rebuilt[$name]))) {
                $this->dropTriggers($src);
            }
        }
        foreach ($d->dropped as $name) {
            if (PlanDiff::hasTriggers($d->source[$name])) {
                $this->dropTriggers($d->source[$name]);
            }
        }
        // 2. foreign key, 3. check, unique, index
        if (!$sqlite) {
            foreach (PlanDiff::sortedKeys($d->dropObjects) as $s) {
                foreach ($d->dropObjects[$s] as $o) {
                    if ($o[0] === 'foreign_key') {
                        $this->dropObject($s, $o);
                    }
                }
            }
        }
        foreach (PlanDiff::sortedKeys($d->dropObjects) as $s) {
            if ($sqlite && (isset($this->rebuilt[$this->targetName($s)]) || in_array($s, $d->dropped, true))) {
                continue;
            }
            foreach ($d->dropObjects[$s] as $o) {
                if ($o[0] !== 'foreign_key' && !($sqlite && $o[0] === 'check')) {
                    $this->dropObject($s, $o);
                }
            }
        }
        $rendererChecks = [];
        if (!$sqlite) {
            foreach ($d->matched as $name) {
                $src = $d->source[$d->tableOf[$name]];
                $before = $this->rendererChecks($src);
                $after = $this->rendererChecks($d->target[$name]);
                $rendererChecks[$name] = [$before, $after];
                foreach (PlanDiff::sortedKeys($before) as $n) {
                    if (($after[$n] ?? null) !== $before[$n]) {
                        $this->add($this->dropCheck($src->name, $n));
                    }
                }
            }
        }
        // 4. rename
        foreach (PlanText::sortedBy($d->renamedTables, static fn(TableRename $r): string => $r->old) as $r) {
            $this->add('ALTER TABLE ' . $this->q($r->old) . ' RENAME TO ' . $this->q($r->new));
        }
        foreach (PlanText::sortedBy($d->renamedColumns, static fn(ColumnRename $r): string => "{$r->table}.{$r->old}") as $r) {
            $this->add('ALTER TABLE ' . $this->q($r->table) . ' RENAME COLUMN ' . $this->q($r->old) . ' TO ' . $this->q($r->new));
        }
        // 5. drop column, drop table
        if (!$sqlite) {
            foreach ($d->matched as $name) {
                foreach ($d->removed[$name] ?? [] as $c) {
                    $this->add('ALTER TABLE ' . $this->q($name) . ' DROP COLUMN ' . $this->q($c));
                }
            }
        }
        foreach ($d->dropped as $name) {
            $this->add('DROP TABLE ' . $this->q($name));
        }
        // 6. create table
        foreach ($d->created as $name) {
            $this->add(...$this->r->table($d->target[$name]));
        }
        // 7. add, alter column; SQLite rebuild
        foreach ($d->matched as $name) {
            if ($sqlite) {
                if (isset($this->rebuilt[$name])) {
                    $this->rebuild($name);
                }
                continue;
            }
            $t = $d->target[$name];
            foreach ($d->added[$name] ?? [] as $c) {
                $this->add('ALTER TABLE ' . $this->q($name) . ' ADD COLUMN ' . $this->r->column(PlanDiff::column($t, $c)));
            }
            foreach ($d->altered[$name] ?? [] as $c) {
                $this->alterColumn($name, PlanDiff::column($d->source[$d->tableOf[$name]], $d->columnOf[$name][$c]), PlanDiff::column($t, $c));
            }
        }
        // 8. unique, index, check
        foreach (PlanDiff::sortedKeys($d->addObjects) as $t) {
            if (isset($this->rebuilt[$t])) {
                continue;
            }
            foreach ($d->addObjects[$t] as $o) {
                if ($o[0] !== 'foreign_key' && !($sqlite && $o[0] === 'check')) {
                    $this->addObject($t, $o);
                }
            }
        }
        if (!$sqlite) {
            foreach ($d->matched as $name) {
                [$before, $after] = $rendererChecks[$name];
                foreach (PlanDiff::sortedKeys($after) as $n) {
                    if (($before[$n] ?? null) !== $after[$n]) {
                        $this->add('ALTER TABLE ' . $this->q($name) . ' ADD CONSTRAINT ' . $this->q($n) . " CHECK ({$after[$n]})");
                    }
                }
            }
        }
        // 9. foreign key
        if (!$sqlite) {
            foreach ($d->created as $name) {
                foreach (PlanText::sortedBy($d->target[$name]->foreignKeys, static fn(ForeignKey $f): string => $f->name) as $f) {
                    $this->add('ALTER TABLE ' . $this->q($name) . ' ADD ' . $this->r->foreignKey($f));
                }
            }
            foreach (PlanDiff::sortedKeys($d->addObjects) as $t) {
                foreach ($d->addObjects[$t] as $o) {
                    if ($o[0] === 'foreign_key') {
                        $this->addObject($t, $o);
                    }
                }
            }
        }
        // 10. trigger
        foreach ($d->created as $name) {
            $this->add(...$this->r->triggers($d->target[$name]));
        }
        foreach ($d->matched as $name) {
            $t = $d->target[$name];
            if (PlanDiff::hasTriggers($t) && (isset($d->triggers[$name]) || isset($this->rebuilt[$name]))) {
                $this->add(...$this->r->triggers($t));
            }
        }
    }

    /** source table 의 target 이름; 지우는 table 은 source 이름 그대로다. */
    private function targetName(string $source): string
    {
        $target = array_search($source, $this->d->tableOf, true);
        return $target === false ? $source : (string) $target;
    }

    /**
     * SQLite 가 table 을 다시 만들어야 하는지 알려 준다: 이름, column, foreign
     * key, check 중 하나라도 바뀌면 그렇다. index 와 unique 만 바뀌거나 trigger
     * 만 바뀌면 다시 만들지 않는다.
     */
    private function sqliteRebuilds(string $name): bool
    {
        $d = $this->d;
        if ($d->tableOf[$name] !== $name || isset($d->added[$name]) || isset($d->removed[$name]) || isset($d->altered[$name])) {
            return true;
        }
        foreach ($d->renamedColumns as $r) {
            if ($r->table === $name) {
                return true;
            }
        }
        foreach ([...$d->dropObjects[$d->tableOf[$name]] ?? [], ...$d->addObjects[$name] ?? []] as $o) {
            if ($o[0] === 'foreign_key' || $o[0] === 'check') {
                return true;
            }
        }
        return false;
    }

    /** SQLite table 을 target 정의로 다시 만들고 맞는 column 을 옮긴다. */
    private function rebuild(string $name): void
    {
        $d = $this->d;
        $t = $d->target[$name];
        $src = $d->source[$d->tableOf[$name]];
        $statements = $this->r->table($t);
        $prefix = 'CREATE TABLE ' . $this->q($name) . ' (';
        if (!str_starts_with($statements[0], $prefix)) {
            throw new \LogicException("The rendered table $name does not start with $prefix");
        }
        $this->add('CREATE TABLE ' . $this->q('$rebuild') . ' (' . substr($statements[0], strlen($prefix)));
        // AUTOINCREMENT counter 를 옮겨, 지운 row 의 key 까지 다시 쓰지 않는다. dbspec
        // 이름에는 따옴표가 없으므로 문자열 literal 로 그대로 쓴다.
        foreach ($t->columns as $c) {
            if ($c->identity) {
                $this->add("INSERT INTO sqlite_sequence (name, seq) SELECT '\$rebuild', seq FROM sqlite_sequence WHERE name = '$name'");
            }
        }
        $into = [];
        $from = [];
        foreach ($t->columns as $c) {
            $old = $d->columnOf[$name][$c->name] ?? null;
            if ($old === null) {
                continue;
            }
            $into[] = $this->q($c->name);
            // rename 은 이미 끝났으므로 source column 은 target 이름이다.
            $from[] = $this->copyValue(PlanDiff::column($src, $old), $c);
        }
        $this->add('INSERT INTO ' . $this->q('$rebuild') . ' (' . implode(', ', $into) . ') SELECT ' . implode(', ', $from) . ' FROM ' . $this->q($name));
        $this->add('DROP TABLE ' . $this->q($name));
        $this->add('ALTER TABLE ' . $this->q('$rebuild') . ' RENAME TO ' . $this->q($name));
        $this->add(...array_slice($statements, 1));
    }

    /**
     * SQLite rebuild 에서 source 값을 target column 형식으로 옮기는 식이다.
     * time 과 datetime 은 늘어난 소수 자리를 0 으로 채운다.
     */
    private function copyValue(Column $from, Column $to): string
    {
        $q = $this->q($to->name);
        if (($to->type->name === 'time' || $to->type->name === 'datetime') && $to->type->parameters[0] > $from->type->parameters[0]) {
            $pad = str_repeat('0', $to->type->parameters[0] - $from->type->parameters[0]);
            if ($from->type->parameters[0] === 0) {
                $pad = ".$pad";
            }
            return "$q || '$pad'";
        }
        return $q;
    }

    private function alterColumn(string $table, Column $from, Column $to): void
    {
        if ($this->r->dialect === 'mysql') {
            $this->add('ALTER TABLE ' . $this->q($table) . ' MODIFY COLUMN ' . $this->r->column($to));
            return;
        }
        $prefix = 'ALTER TABLE ' . $this->q($table) . ' ALTER COLUMN ' . $this->q($to->name);
        $sameType = PlanDiff::sameType($from->type, $to->type);
        if (!$sameType) {
            $this->add("$prefix TYPE " . $this->r->typeText($to->type));
        }
        if ($from->nullable !== $to->nullable) {
            $this->add($prefix . ($to->nullable ? ' DROP NOT NULL' : ' SET NOT NULL'));
        }
        if ($from->default !== $to->default || ($to->default !== null && !$sameType)) {
            $this->add($to->default === null ? "$prefix DROP DEFAULT" : "$prefix SET DEFAULT " . $this->r->defaultText($to->type, $to->default));
        }
    }

    private function dropTriggers(Table $t): void
    {
        foreach ($this->r->triggers($t) as $s) {
            if (!str_starts_with($s, 'CREATE TRIGGER ')) {
                continue;
            }
            $rest = substr($s, strlen('CREATE TRIGGER '));
            $name = substr($rest, 0, strpos($rest, ' '));
            if ($this->r->dialect === 'postgres') {
                $this->add("DROP TRIGGER $name ON " . $this->q($t->name), "DROP FUNCTION $name()");
            } else {
                $this->add("DROP TRIGGER $name");
            }
        }
    }

    private function dropCheck(string $table, string $name): string
    {
        return 'ALTER TABLE ' . $this->q($table) . ($this->r->dialect === 'mysql' ? ' DROP CHECK ' : ' DROP CONSTRAINT ') . $this->q($name);
    }

    /** @param array{0: string, 1: string} $o [kind, name] */
    private function dropObject(string $table, array $o): void
    {
        [$kind, $name] = $o;
        $dialect = $this->r->dialect;
        $this->add(match (true) {
            $kind === 'check' => $this->dropCheck($table, $name),
            $kind === 'foreign_key' && $dialect === 'mysql' => 'ALTER TABLE ' . $this->q($table) . ' DROP FOREIGN KEY ' . $this->q($name),
            $kind === 'unique' && $dialect === 'mysql' => 'ALTER TABLE ' . $this->q($table) . ' DROP INDEX ' . $this->q($name),
            $kind === 'index' && $dialect === 'mysql' => 'DROP INDEX ' . $this->q($name) . ' ON ' . $this->q($table),
            ($kind === 'foreign_key' || $kind === 'unique') && $dialect === 'postgres' => 'ALTER TABLE ' . $this->q($table) . ' DROP CONSTRAINT ' . $this->q($name),
            default => 'DROP INDEX ' . $this->q($name),
        });
    }

    /** @param array{0: string, 1: string} $o [kind, name] */
    private function addObject(string $table, array $o): void
    {
        [$kind, $name] = $o;
        $t = $this->d->target[$table];
        switch ($kind) {
            case 'unique':
                $u = PlanObjects::named($t->uniqueKeys, $name);
                if ($this->r->dialect === 'sqlite') {
                    $this->add('CREATE UNIQUE INDEX ' . $this->q($u->name) . ' ON ' . $this->q($table) . ' (' . $this->r->list($u->columns) . ')');
                    return;
                }
                $this->add('ALTER TABLE ' . $this->q($table) . ' ADD CONSTRAINT ' . $this->q($u->name) . ' UNIQUE (' . $this->r->list($u->columns) . ')');
                return;
            case 'index':
                $x = PlanObjects::named($t->indexes, $name);
                $columns = array_map(fn(IndexColumn $c): string => $this->q($c->name) . ($c->descending ? ' DESC' : ''), $x->columns);
                $this->add('CREATE INDEX ' . $this->q($x->name) . ' ON ' . $this->q($table) . ' (' . implode(', ', $columns) . ')');
                return;
            case 'check':
                $k = PlanObjects::named($t->checks, $name);
                $this->add('ALTER TABLE ' . $this->q($table) . ' ADD CONSTRAINT ' . $this->q($k->name) . ' CHECK (' . $this->r->checkText($t, $k) . ')');
                return;
            case 'foreign_key':
                $this->add('ALTER TABLE ' . $this->q($table) . ' ADD ' . $this->r->foreignKey(PlanObjects::named($t->foreignKeys, $name)));
                return;
        }
        throw new \LogicException("Unknown object kind $kind");
    }

    /**
     * table 의 renderer CHECK 이름과 식이다.
     *
     * @return array<string, string>
     */
    private function rendererChecks(Table $t): array
    {
        $out = [];
        foreach ($t->columns as $c) {
            $check = $this->r->typeCheck($c);
            if ($check !== '') {
                $out[$t->name . '$' . $c->name] = $check;
            }
        }
        return $out;
    }
}
