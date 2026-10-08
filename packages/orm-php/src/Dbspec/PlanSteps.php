<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Writes the steps of a plan's diff in one dialect, each with its rollback
 * statement and effect (docs/plans.md "Steps").
 *
 * @internal
 */
final class PlanSteps
{
    /** 되돌릴 수 없는 step 의 이유(docs/plans.md "Irreversible steps"). */
    public const IRREVERSIBLE_PRECISION = 'narrowing the precision rounds the values written since';
    /** SQLite 다시 만들기의 작업 table. */
    public const REBUILD_TABLE = 'dbspec$rebuild';

    /** @var list<PlanStep> */
    private array $out = [];
    /** @var array<string, true> SQLite 에서 다시 만드는 target table */
    private array $rebuilt = [];
    /**
     * 보관 이름: "table.column"(지우는 column, source table 과 column 이름), table(지우는
     * table), "+table.column"(더하는 column, target 이름)
     *
     * @var array<string, string>
     */
    private array $holds = [];
    /** @var list<string> */
    private array $holdOrder = [];

    private function __construct(private readonly PlanDiff $d, private readonly Renderer $r, private readonly string $holdPrefix)
    {
    }

    /** @return list<PlanStep> */
    public static function write(PlanDiff $d, Renderer $r, Plan $plan): array
    {
        $hash = substr($plan->to, strlen('sha256:'), 12);
        $w = new self($d, $r, 'dbspec$hold$' . $hash . '$');
        $w->steps();
        return $w->out;
    }

    private function add(PlanStep $s): void
    {
        $this->out[] = $s;
    }

    private function q(string $name): string
    {
        return $this->r->q($name);
    }

    private static function present(string $kind, string $table, string $name): Effect
    {
        return new Effect($kind, $table, $name, true);
    }

    private static function absent(string $kind, string $table, string $name): Effect
    {
        return new Effect($kind, $table, $name, false);
    }

    private function hold(string $key): string
    {
        return $this->holds[$key] ?? throw new \LogicException("No holding name for $key");
    }

    /** docs/plans.md "Hiding instead of dropping"의 순서로 보관 이름을 정한다. */
    private function numberHolds(): void
    {
        $d = $this->d;
        $n = 0;
        $next = function (string $key) use (&$n): void {
            $n++;
            $this->holds[$key] = $this->holdPrefix . $n;
            $this->holdOrder[] = $key;
        };
        foreach ($d->matched as $name) {
            foreach ($d->removed[$name] ?? [] as $c) {
                $next($d->tableOf[$name] . '.' . $c);
            }
        }
        foreach ($d->dropped as $name) {
            $next($name);
        }
        foreach ($d->matched as $name) {
            foreach ($d->added[$name] ?? [] as $c) {
                $next("+$name.$c");
            }
        }
    }

    private function steps(): void
    {
        $d = $this->d;
        $sqlite = $this->r->dialect === 'sqlite';
        $this->numberHolds();
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
        // 2. foreign key
        if (!$sqlite) {
            foreach (PlanDiff::sortedKeys($d->dropObjects) as $s) {
                foreach ($d->dropObjects[$s] as $o) {
                    if ($o[0] === 'foreign_key') {
                        $this->dropObject($d->source[$s], $o);
                    }
                }
            }
        }
        // 3. check, unique, index 와 지우는 table 의 객체
        $dropTables = [];
        foreach ($d->dropObjects as $s => $objects) {
            if ($sqlite && (isset($this->rebuilt[$this->targetName((string) $s)]) || in_array((string) $s, $d->dropped, true))) {
                continue;
            }
            foreach ($objects as $o) {
                if ($o[0] !== 'foreign_key' && !($sqlite && $o[0] === 'check')) {
                    $dropTables[(string) $s][] = $o;
                }
            }
        }
        foreach ($d->dropped as $s) {
            $t = $d->source[$s];
            foreach ($t->uniqueKeys as $u) {
                $dropTables[$s][] = ['unique', $u->name];
            }
            foreach ($t->indexes as $x) {
                $dropTables[$s][] = ['index', $x->name];
            }
            if (!$sqlite) {
                foreach ($t->checks as $k) {
                    $dropTables[$s][] = ['check', $k->name];
                }
            }
        }
        foreach (PlanDiff::sortedKeys($dropTables) as $s) {
            $objects = $dropTables[$s];
            usort($objects, static fn(array $a, array $b): int => strcmp($a[0] . "\0" . $a[1], $b[0] . "\0" . $b[1]));
            foreach ($objects as $o) {
                $this->dropObject($d->source[$s], $o);
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
                        $this->dropRendererCheck($src->name, $n, $before[$n]);
                    }
                }
            }
            foreach ($d->dropped as $s) {
                $before = $this->rendererChecks($d->source[$s]);
                foreach (PlanDiff::sortedKeys($before) as $n) {
                    $this->dropRendererCheck($s, $n, $before[$n]);
                }
            }
        }
        // 4. rename
        foreach (PlanText::sortedBy($d->renamedTables, static fn(TableRename $r): string => $r->old) as $r) {
            $this->add(new PlanStep(
                'ALTER TABLE ' . $this->q($r->old) . ' RENAME TO ' . $this->q($r->new),
                'ALTER TABLE ' . $this->q($r->new) . ' RENAME TO ' . $this->q($r->old),
                '',
                self::present('table', $r->new, ''),
            ));
        }
        foreach (PlanText::sortedBy($d->renamedColumns, static fn(ColumnRename $r): string => "{$r->table}.{$r->old}") as $r) {
            $this->add(new PlanStep($this->renameColumn($r->table, $r->old, $r->new), $this->renameColumn($r->table, $r->new, $r->old), '', self::present('column', $r->table, $r->new)));
        }
        // 5. 지우는 column 과 table 을 숨긴다
        if (!$sqlite) {
            foreach ($d->matched as $name) {
                $src = $d->source[$d->tableOf[$name]];
                foreach ($d->removed[$name] ?? [] as $c) {
                    $this->hideColumn($name, self::column($src, $c), $this->hold($src->name . '.' . $c));
                }
            }
        }
        foreach ($d->dropped as $name) {
            $h = $this->hold($name);
            $this->add(new PlanStep(
                'ALTER TABLE ' . $this->q($name) . ' RENAME TO ' . $this->q($h),
                'ALTER TABLE ' . $this->q($h) . ' RENAME TO ' . $this->q($name),
                '',
                self::present('table', $h, ''),
            ));
        }
        // 6. create table
        foreach ($d->created as $name) {
            $t = $d->target[$name];
            $this->add(new PlanStep($this->r->table($t)[0], 'DROP TABLE ' . $this->q($name), '', self::present('table', $name, '')));
            $this->createIndexes($t, $name);
        }
        // 7. add, alter column; SQLite 다시 만들기
        foreach ($d->matched as $name) {
            if ($sqlite) {
                if (isset($this->rebuilt[$name])) {
                    $this->rebuild($name);
                }
                continue;
            }
            $t = $d->target[$name];
            $src = $d->source[$d->tableOf[$name]];
            foreach ($d->added[$name] ?? [] as $c) {
                $h = $this->hold("+$name.$c");
                $this->add(new PlanStep(
                    'ALTER TABLE ' . $this->q($name) . ' ADD COLUMN ' . $this->r->column(self::column($t, $c)),
                    $this->renameColumn($name, $c, $h),
                    '',
                    self::present('column', $name, $c),
                    restore: $this->renameColumn($name, $h, $c),
                    restoreIf: self::present('column', $name, $h),
                ));
            }
            foreach ($d->altered[$name] ?? [] as $c) {
                $this->alterColumn($name, self::column($src, $d->columnOf[$name][$c]), self::column($t, $c));
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
                        $this->add(new PlanStep(
                            'ALTER TABLE ' . $this->q($name) . ' ADD CONSTRAINT ' . $this->q($n) . " CHECK ({$after[$n]})",
                            $this->dropCheck($name, $n),
                            '',
                            self::present('constraint', $name, $n),
                        ));
                    }
                }
            }
        }
        // 9. foreign key
        if (!$sqlite) {
            foreach ($d->created as $name) {
                foreach (PlanText::sortedBy($d->target[$name]->foreignKeys, static fn(ForeignKey $f): string => $f->name) as $f) {
                    $this->addObject($name, ['foreign_key', $f->name]);
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
            $this->createTriggers($d->target[$name]);
        }
        foreach ($d->matched as $name) {
            $t = $d->target[$name];
            if (PlanDiff::hasTriggers($t) && (isset($d->triggers[$name]) || isset($this->rebuilt[$name]))) {
                $this->createTriggers($t);
            }
        }
        // 11. finalize
        foreach ($this->holdOrder as $key) {
            $h = $this->holds[$key];
            if (str_starts_with($key, '+')) {
                continue;
            }
            if (str_contains($key, '.')) {
                $table = $this->targetName(substr($key, 0, (int) strpos($key, '.')));
                $this->add(new PlanStep('ALTER TABLE ' . $this->q($table) . ' DROP COLUMN ' . $this->q($h), '', '', self::absent('column', $table, $h), finalize: true));
                continue;
            }
            $this->add(new PlanStep('DROP TABLE ' . $this->q($h), '', '', self::absent('table', $h, ''), finalize: true));
        }
    }

    private static function column(Table $t, string $name): Column
    {
        return PlanDiff::column($t, $name) ?? throw new \LogicException("Table {$t->name} has no column $name");
    }

    /** source table 의 target 이름; 지우는 table 은 source 이름 그대로다. */
    private function targetName(string $source): string
    {
        $target = array_search($source, $this->d->tableOf, true);
        return $target === false ? $source : (string) $target;
    }

    private function renameColumn(string $table, string $from, string $to): string
    {
        return 'ALTER TABLE ' . $this->q($table) . ' RENAME COLUMN ' . $this->q($from) . ' TO ' . $this->q($to);
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

    /** MySQL 과 PostgreSQL 에서 지우는 column 을 nullable 로 바꾸고 보관 이름으로 숨긴다. */
    private function hideColumn(string $table, Column $c, string $h): void
    {
        if (!$c->nullable) {
            $nullable = new Column($c->name, $c->type, true, $c->identity, $c->default);
            $checks = [$this->nullCheck($table, $h, $c)];
            if ($this->r->dialect === 'mysql') {
                $this->add(new PlanStep(
                    'ALTER TABLE ' . $this->q($table) . ' MODIFY COLUMN ' . $this->r->column($nullable),
                    'ALTER TABLE ' . $this->q($table) . ' MODIFY COLUMN ' . $this->r->column($c),
                    '',
                    Effect::repeat(),
                    nullChecks: $checks,
                ));
            } else {
                $prefix = 'ALTER TABLE ' . $this->q($table) . ' ALTER COLUMN ' . $this->q($c->name);
                $this->add(new PlanStep("$prefix DROP NOT NULL", "$prefix SET NOT NULL", '', Effect::repeat(), nullChecks: $checks));
            }
        }
        $this->add(new PlanStep($this->renameColumn($table, $c->name, $h), $this->renameColumn($table, $h, $c->name), '', self::present('column', $table, $h)));
    }

    /** source column c 를 non-null 로 되돌리는 rollback 의 null 검사다. */
    private function nullCheck(string $table, string $column, Column $c): NullCheck
    {
        return new NullCheck($table, $column, $c->default === null ? null : $this->r->defaultText($c->type, $c->default));
    }

    /** time 이나 datetime 의 정밀도가 커지는지 알려 준다. */
    private static function precisionGrows(ColumnType $from, ColumnType $to): bool
    {
        return ($to->name === 'time' || $to->name === 'datetime') && $to->name === $from->name && $to->parameters[0] > $from->parameters[0];
    }

    /** SQLite table 을 작업 table 을 거쳐 다시 만든다(docs/plans.md "Steps"). */
    private function rebuild(string $name): void
    {
        $d = $this->d;
        $t = $d->target[$name];
        $src = $d->source[$d->tableOf[$name]];
        $work = $this->q(self::REBUILD_TABLE);
        // 새 정의: target table 과 보관 이름의 지우는 column
        $hiddenDropped = [];
        foreach ($d->removed[$name] ?? [] as $c) {
            $col = self::column($src, $c);
            $hiddenDropped[] = new Column($this->hold($src->name . '.' . $c), $col->type, $col->nullable, $col->identity, $col->default);
        }
        // 옛 정의: 이름 바꾸기를 적용한 source table 과 보관 이름의 더하는 column
        $old = $this->renamedSource($name);
        $hiddenAdded = [];
        foreach ($d->added[$name] ?? [] as $c) {
            $col = self::column($t, $c);
            $hiddenAdded[] = new Column($this->hold("+$name.$c"), $col->type, $col->nullable, $col->identity, $col->default);
        }
        $newCreate = fn(string $as): string => $this->r->createTable($t, $as, static fn(string $c): string => $t->name . '$' . $c, $hiddenDropped);
        // sourceColumn 은 옛 정의 column 의 source 이름이다. 지우는 column 은 이름이 그대로다.
        $sourceColumn = static fn(string $c): string => $d->columnOf[$name][$c] ?? $c;
        $oldCreate = $this->r->createTable($old, $name, static fn(string $c): string => $src->name . '$' . $sourceColumn($c), $hiddenAdded);
        $newColumns = [];
        foreach ($t->columns as $c) {
            $newColumns[] = $c->name;
        }
        foreach ($hiddenDropped as $c) {
            $newColumns[] = $c->name;
        }
        $newList = $this->r->list($newColumns);
        // 옛 table 에서 새 정의로 옮기는 식
        $into = $from = $intoRestore = $fromRestore = [];
        foreach ($t->columns as $c) {
            $oldName = $d->columnOf[$name][$c->name] ?? null;
            if ($oldName !== null) {
                $e = $this->copyValue(self::column($src, $oldName), $c);
                $into[] = $this->q($c->name);
                $from[] = $e;
                $intoRestore[] = $this->q($c->name);
                $fromRestore[] = $e;
            } else {
                $intoRestore[] = $this->q($c->name);
                $fromRestore[] = $this->q($this->hold("+$name.{$c->name}"));
            }
        }
        foreach ($d->removed[$name] ?? [] as $i => $c) {
            $into[] = $this->q($hiddenDropped[$i]->name);
            $from[] = $this->q($c);
            $intoRestore[] = $this->q($hiddenDropped[$i]->name);
            $fromRestore[] = $this->q($c);
        }
        // 새 정의에서 옛 정의로 되돌리는 식
        $backInto = $backFrom = [];
        $irreversible = '';
        $checks = [];
        $removed = $d->removed[$name] ?? [];
        foreach ($old->columns as $c) {
            $backInto[] = $this->q($c->name);
            $sourceName = $sourceColumn($c->name);
            $tc = PlanDiff::column($t, $c->name);
            if ($tc !== null && !in_array($sourceName, $removed, true)) {
                $backFrom[] = $this->q($c->name);
                if (self::precisionGrows($c->type, $tc->type)) {
                    $irreversible = self::IRREVERSIBLE_PRECISION;
                }
                if (!$c->nullable && $tc->nullable) {
                    $checks[] = $this->nullCheck($name, $c->name, $c);
                }
                continue;
            }
            // 지우는 column: 새 정의에서는 보관 이름이다.
            $h = $this->hold($src->name . '.' . $sourceName);
            $backFrom[] = $this->q($h);
            if (!$c->nullable) {
                $checks[] = $this->nullCheck($name, $h, $c);
            }
        }
        // 옛 table 에 숨긴 더한 column 이 있으면 그 값도 되돌린다.
        $backIntoRestore = $backInto;
        $backFromRestore = $backFrom;
        foreach ($d->added[$name] ?? [] as $i => $c) {
            $backIntoRestore[] = $this->q($hiddenAdded[$i]->name);
            $backFromRestore[] = $this->q($c);
        }
        $identity = false;
        foreach ($t->columns as $c) {
            $identity = $identity || $c->identity;
        }
        $sequence = static fn(string $to, string $from): string => "INSERT INTO sqlite_sequence (name, seq) SELECT '$to', seq FROM sqlite_sequence WHERE name = '$from'";
        $unsequence = static fn(string $n): string => "DELETE FROM sqlite_sequence WHERE name = '$n'";
        $q = $this->q($name);
        $rebuild = self::REBUILD_TABLE;

        $this->add(new PlanStep($newCreate($rebuild), "DROP TABLE $work", '', self::present('table', $rebuild, '')));
        if ($identity) {
            $this->add(new PlanStep($sequence($rebuild, $name), $unsequence($rebuild), '', self::present('sequence', $rebuild, '')));
        }
        $copyIn = "INSERT INTO $work (" . implode(', ', $into) . ') SELECT ' . implode(', ', $from) . " FROM $q";
        if ($hiddenAdded !== []) {
            $this->add(new PlanStep(
                $copyIn,
                "DELETE FROM $work",
                '',
                self::present('rows', $rebuild, ''),
                restore: "INSERT INTO $work (" . implode(', ', $intoRestore) . ') SELECT ' . implode(', ', $fromRestore) . " FROM $q",
                restoreIf: self::present('column', $name, $hiddenAdded[0]->name),
            ));
        } else {
            $this->add(new PlanStep($copyIn, "DELETE FROM $work", '', self::present('rows', $rebuild, '')));
        }
        foreach ($this->indexes($old, $name) as [$indexName, $create, $drop]) {
            $this->add(new PlanStep($drop, $create, '', self::absent('index', $name, $indexName)));
        }
        if ($irreversible !== '') {
            $this->add(new PlanStep("DELETE FROM $q", '', $irreversible, self::absent('rows', $name, ''), nullChecks: $checks));
        } elseif ($hiddenAdded !== []) {
            $this->add(new PlanStep(
                "DELETE FROM $q",
                "INSERT INTO $q (" . implode(', ', $backInto) . ') SELECT ' . implode(', ', $backFrom) . " FROM $work",
                '',
                self::absent('rows', $name, ''),
                rollbackRestore: "INSERT INTO $q (" . implode(', ', $backIntoRestore) . ') SELECT ' . implode(', ', $backFromRestore) . " FROM $work",
                restoreIf: self::present('column', $name, $hiddenAdded[0]->name),
                nullChecks: $checks,
            ));
        } else {
            $this->add(new PlanStep(
                "DELETE FROM $q",
                "INSERT INTO $q (" . implode(', ', $backInto) . ') SELECT ' . implode(', ', $backFrom) . " FROM $work",
                '',
                self::absent('rows', $name, ''),
                nullChecks: $checks,
            ));
        }
        if ($identity) {
            $this->add(new PlanStep($unsequence($name), $sequence($name, $rebuild), '', self::absent('sequence', $name, '')));
        }
        $this->add(new PlanStep("DROP TABLE $q", $oldCreate, '', self::absent('table', $name, '')));
        $this->add(new PlanStep($newCreate($name), "DROP TABLE $q", '', self::present('table', $name, '')));
        if ($identity) {
            $this->add(new PlanStep($sequence($name, $rebuild), $unsequence($name), '', self::present('sequence', $name, '')));
        }
        $this->add(new PlanStep("INSERT INTO $q ($newList) SELECT $newList FROM $work", "DELETE FROM $q", '', self::present('rows', $name, '')));
        $this->add(new PlanStep("DELETE FROM $work", "INSERT INTO $work ($newList) SELECT $newList FROM $q", '', self::absent('rows', $rebuild, '')));
        if ($identity) {
            $this->add(new PlanStep($unsequence($rebuild), $sequence($rebuild, $name), '', self::absent('sequence', $rebuild, '')));
        }
        $this->add(new PlanStep("DROP TABLE $work", $newCreate($rebuild), '', self::absent('table', $rebuild, '')));
        $this->createIndexes($t, $name);
    }

    /**
     * target table name 의 source table 에 이름 바꾸기를 적용한 정의다. 지우는 table 을
     * 참조하는 foreign key 는 source 이름을 유지한다.
     */
    private function renamedSource(string $name): Table
    {
        $d = $this->d;
        $src = $d->source[$d->tableOf[$name]];
        $targetOfTable = array_flip($d->tableOf);
        $column = static function (string $table, string $c) use ($d): string {
            foreach ($d->columnOf[$table] ?? [] as $tc => $sc) {
                if ($sc === $c) {
                    return (string) $tc;
                }
            }
            return $c;
        };
        $rename = static fn(array $cols): array => array_map(static fn(string $c): string => $column($name, $c), $cols);
        $t = new Table($name);
        foreach ($src->columns as $c) {
            $t->columns[] = new Column($column($name, $c->name), $c->type, $c->nullable, $c->identity, $c->default);
        }
        $t->primaryKey = new PrimaryKey($rename($src->primaryKey?->columns ?? []));
        foreach ($src->uniqueKeys as $u) {
            $t->uniqueKeys[] = new UniqueKey($u->name, $rename($u->columns));
        }
        foreach ($src->indexes as $x) {
            $t->indexes[] = new Index($x->name, array_map(static fn(IndexColumn $c): IndexColumn => new IndexColumn($column($name, $c->name), $c->descending), $x->columns));
        }
        foreach ($src->foreignKeys as $f) {
            $parent = isset($targetOfTable[$f->table]) ? (string) $targetOfTable[$f->table] : $f->table;
            $refs = array_map(static fn(string $c): string => $column($parent, $c), $f->referencedColumns);
            $t->foreignKeys[] = new ForeignKey($f->name, $rename($f->columns), $parent, $refs, $f->onDelete, $f->onUpdate);
        }
        foreach ($src->checks as $k) {
            $t->checks[] = new Check($k->name, PlanObjects::checkText($k->expression, static fn(string $c): string => $column($name, $c)));
        }
        return $t;
    }

    /**
     * SQLite 다시 만들기에서 source 값을 target column 형식으로 옮기는 식이다.
     * time 과 datetime 은 늘어난 소수 자리를 0 으로 채운다.
     */
    private function copyValue(Column $from, Column $to): string
    {
        $q = $this->q($to->name);
        if (self::precisionGrows($from->type, $to->type)) {
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
        $irreversible = self::precisionGrows($from->type, $to->type) ? self::IRREVERSIBLE_PRECISION : '';
        $source = new Column($to->name, $from->type, $from->nullable, $from->identity, $from->default);
        $checks = !$from->nullable && $to->nullable ? [$this->nullCheck($table, $to->name, $source)] : [];
        if ($this->r->dialect === 'mysql') {
            $this->add(new PlanStep(
                'ALTER TABLE ' . $this->q($table) . ' MODIFY COLUMN ' . $this->r->column($to),
                $irreversible === '' ? 'ALTER TABLE ' . $this->q($table) . ' MODIFY COLUMN ' . $this->r->column($source) : '',
                $irreversible,
                Effect::repeat(),
                nullChecks: $checks,
            ));
            return;
        }
        $prefix = 'ALTER TABLE ' . $this->q($table) . ' ALTER COLUMN ' . $this->q($to->name);
        $sameType = PlanDiff::sameType($from->type, $to->type);
        if (!$sameType) {
            $this->add(new PlanStep(
                "$prefix TYPE " . $this->r->typeText($to->type),
                $irreversible === '' ? "$prefix TYPE " . $this->r->typeText($from->type) : '',
                $irreversible,
                Effect::repeat(),
            ));
        }
        if ($from->nullable !== $to->nullable) {
            if ($to->nullable) {
                $this->add(new PlanStep("$prefix DROP NOT NULL", "$prefix SET NOT NULL", '', Effect::repeat(), nullChecks: $checks));
            } else {
                $this->add(new PlanStep("$prefix SET NOT NULL", "$prefix DROP NOT NULL", '', Effect::repeat()));
            }
        }
        if ($from->default !== $to->default || ($to->default !== null && !$sameType)) {
            $back = $from->default === null ? "$prefix DROP DEFAULT" : "$prefix SET DEFAULT " . $this->r->defaultText($from->type, $from->default);
            $forward = $to->default === null ? "$prefix DROP DEFAULT" : "$prefix SET DEFAULT " . $this->r->defaultText($to->type, $to->default);
            $this->add(new PlanStep($forward, $back, '', Effect::repeat()));
        }
    }

    /**
     * 렌더링한 trigger statement 에서 trigger 이름, CREATE TRIGGER 와 PostgreSQL
     * function 을 짝짓는다.
     *
     * @return list<array{0: string, 1: string, 2: string}>
     */
    private function triggerParts(Table $t): array
    {
        $out = [];
        $function = '';
        foreach ($this->r->triggers($t) as $s) {
            if (str_starts_with($s, 'CREATE FUNCTION ')) {
                $function = $s;
                continue;
            }
            $rest = substr($s, strlen('CREATE TRIGGER '));
            $quoted = substr($rest, 0, (int) strpos($rest, ' '));
            $out[] = [substr($quoted, 1, -1), $s, $function];
            $function = '';
        }
        return $out;
    }

    private function dropTriggers(Table $t): void
    {
        foreach ($this->triggerParts($t) as [$name, $create, $function]) {
            if ($this->r->dialect === 'postgres') {
                $this->add(new PlanStep('DROP TRIGGER ' . $this->q($name) . ' ON ' . $this->q($t->name), $create, '', self::absent('trigger', $t->name, $name)));
                $this->add(new PlanStep('DROP FUNCTION ' . $this->q($name) . '()', $function, '', self::absent('function', '', $name)));
                continue;
            }
            $this->add(new PlanStep('DROP TRIGGER ' . $this->q($name), $create, '', self::absent('trigger', $t->name, $name)));
        }
    }

    private function createTriggers(Table $t): void
    {
        foreach ($this->triggerParts($t) as [$name, $create, $function]) {
            if ($this->r->dialect === 'postgres') {
                $this->add(new PlanStep($function, 'DROP FUNCTION ' . $this->q($name) . '()', '', self::present('function', '', $name)));
                $this->add(new PlanStep($create, 'DROP TRIGGER ' . $this->q($name) . ' ON ' . $this->q($t->name), '', self::present('trigger', $t->name, $name)));
                continue;
            }
            $this->add(new PlanStep($create, 'DROP TRIGGER ' . $this->q($name), '', self::present('trigger', $t->name, $name)));
        }
    }

    private function dropCheck(string $table, string $name): string
    {
        return 'ALTER TABLE ' . $this->q($table) . ($this->r->dialect === 'mysql' ? ' DROP CHECK ' : ' DROP CONSTRAINT ') . $this->q($name);
    }

    private function dropRendererCheck(string $table, string $name, string $expression): void
    {
        $this->add(new PlanStep(
            $this->dropCheck($table, $name),
            'ALTER TABLE ' . $this->q($table) . ' ADD CONSTRAINT ' . $this->q($name) . " CHECK ($expression)",
            '',
            self::absent('constraint', $table, $name),
        ));
    }

    /**
     * table t 를 name 으로 둔 unique key 와 index 를 renderer 순서로 [이름, 만드는
     * statement, 지우는 statement]로 돌려준다. SQLite unique key 는 unique index 다.
     *
     * @return list<array{0: string, 1: string, 2: string}>
     */
    private function indexes(Table $t, string $name): array
    {
        $out = [];
        if ($this->r->dialect === 'sqlite') {
            foreach (PlanText::sortedBy($t->uniqueKeys, static fn(UniqueKey $u): string => $u->name) as $u) {
                $out[] = [$u->name, 'CREATE UNIQUE INDEX ' . $this->q($u->name) . ' ON ' . $this->q($name) . ' (' . $this->r->list($u->columns) . ')', $this->dropIndex($name, $u->name)];
            }
        }
        foreach (PlanText::sortedBy($t->indexes, static fn(Index $x): string => $x->name) as $x) {
            $columns = array_map(fn(IndexColumn $c): string => $this->q($c->name) . ($c->descending ? ' DESC' : ''), $x->columns);
            $out[] = [$x->name, 'CREATE INDEX ' . $this->q($x->name) . ' ON ' . $this->q($name) . ' (' . implode(', ', $columns) . ')', $this->dropIndex($name, $x->name)];
        }
        return $out;
    }

    private function dropIndex(string $table, string $name): string
    {
        return $this->r->dialect === 'mysql' ? 'DROP INDEX ' . $this->q($name) . ' ON ' . $this->q($table) : 'DROP INDEX ' . $this->q($name);
    }

    /** renderer 가 CREATE TABLE 뒤에 쓰는 unique index 와 index 다. */
    private function createIndexes(Table $t, string $name): void
    {
        foreach ($this->indexes($t, $name) as [$indexName, $create, $drop]) {
            $this->add(new PlanStep($create, $drop, '', self::present('index', $name, $indexName)));
        }
    }

    /**
     * table t(name 으로 둔)의 객체 o 를 더하는 statement, 지우는 statement, 그 효과의
     * 종류다.
     *
     * @param array{0: string, 1: string} $o [kind, name]
     * @return array{0: string, 1: string, 2: string}
     */
    private function objectStatements(Table $t, string $name, array $o): array
    {
        [$kind, $objectName] = $o;
        $dialect = $this->r->dialect;
        switch ($kind) {
            case 'unique':
                $u = PlanObjects::named($t->uniqueKeys, $objectName);
                if ($dialect === 'sqlite') {
                    return ['CREATE UNIQUE INDEX ' . $this->q($u->name) . ' ON ' . $this->q($name) . ' (' . $this->r->list($u->columns) . ')', $this->dropIndex($name, $u->name), 'index'];
                }
                $create = 'ALTER TABLE ' . $this->q($name) . ' ADD CONSTRAINT ' . $this->q($u->name) . ' UNIQUE (' . $this->r->list($u->columns) . ')';
                if ($dialect === 'mysql') {
                    return [$create, 'ALTER TABLE ' . $this->q($name) . ' DROP INDEX ' . $this->q($u->name), 'index'];
                }
                return [$create, 'ALTER TABLE ' . $this->q($name) . ' DROP CONSTRAINT ' . $this->q($u->name), 'constraint'];
            case 'index':
                $x = PlanObjects::named($t->indexes, $objectName);
                $columns = array_map(fn(IndexColumn $c): string => $this->q($c->name) . ($c->descending ? ' DESC' : ''), $x->columns);
                return ['CREATE INDEX ' . $this->q($x->name) . ' ON ' . $this->q($name) . ' (' . implode(', ', $columns) . ')', $this->dropIndex($name, $x->name), 'index'];
            case 'check':
                $k = PlanObjects::named($t->checks, $objectName);
                return ['ALTER TABLE ' . $this->q($name) . ' ADD CONSTRAINT ' . $this->q($k->name) . ' CHECK (' . $this->r->checkText($t, $k) . ')', $this->dropCheck($name, $k->name), 'constraint'];
            case 'foreign_key':
                $f = PlanObjects::named($t->foreignKeys, $objectName);
                $drop = 'ALTER TABLE ' . $this->q($name) . ($dialect === 'mysql' ? ' DROP FOREIGN KEY ' : ' DROP CONSTRAINT ') . $this->q($f->name);
                return ['ALTER TABLE ' . $this->q($name) . ' ADD ' . $this->r->foreignKey($f), $drop, 'constraint'];
        }
        throw new \LogicException("Unknown object kind $kind");
    }

    /**
     * source table t 의 객체를 지우고, rollback 은 source 정의로 다시 만든다.
     *
     * @param array{0: string, 1: string} $o [kind, name]
     */
    private function dropObject(Table $t, array $o): void
    {
        [$create, $drop, $kind] = $this->objectStatements($t, $t->name, $o);
        $this->add(new PlanStep($drop, $create, '', self::absent($kind, $t->name, $o[1])));
    }

    /** @param array{0: string, 1: string} $o [kind, name] */
    private function addObject(string $table, array $o): void
    {
        [$create, $drop, $kind] = $this->objectStatements($this->d->target[$table], $table, $o);
        $this->add(new PlanStep($create, $drop, '', self::present($kind, $table, $o[1])));
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
