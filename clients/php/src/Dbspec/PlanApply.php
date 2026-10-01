<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * plan chain 을 connection 하나에 적용하고, MySQL 에서 중단된 plan 을 복구한다
 * (docs/plans.md "Apply"). 객체 하나가 apply 나 recover 한 번의 상태다.
 *
 * @internal
 */
final class PlanApply
{
    /** 적용한 plan 을 기록하는 table. dbspec 이름에는 $ 가 없으므로 사용자 table 과 겹치지 않고, introspection 은 이 table 을 빼고 읽는다. */
    private const HISTORY = 'dbspec$plans';

    /**
     * plan writer 가 쓰는 MySQL statement 형식과 그 효과다 (docs/plans.md "Apply",
     * recovery). 효과가 없는 MODIFY COLUMN 은 다시 실행한다.
     */
    private const MYSQL_EFFECTS = [
        ['/^DROP TRIGGER `([^`]+)`$/D', 'trigger', false],
        ['/^ALTER TABLE `([^`]+)` DROP FOREIGN KEY `([^`]+)`$/D', 'constraint', false],
        ['/^ALTER TABLE `([^`]+)` DROP CHECK `([^`]+)`$/D', 'constraint', false],
        ['/^ALTER TABLE `([^`]+)` DROP INDEX `([^`]+)`$/D', 'index', false],
        ['/^DROP INDEX `([^`]+)` ON `([^`]+)`$/D', 'index_on', false],
        ['/^ALTER TABLE `[^`]+` RENAME TO `([^`]+)`$/D', 'table', true],
        ['/^ALTER TABLE `([^`]+)` RENAME COLUMN `[^`]+` TO `([^`]+)`$/D', 'column', true],
        ['/^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$/D', 'column', false],
        ['/^DROP TABLE `([^`]+)`$/D', 'table', false],
        ['/^CREATE TABLE `([^`]+)` /', 'table', true],
        ['/^CREATE INDEX `([^`]+)` ON `([^`]+)` /', 'index_on', true],
        ['/^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` /', 'column', true],
        ['/^ALTER TABLE `[^`]+` MODIFY COLUMN /', 'repeat', false],
        ['/^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` UNIQUE /', 'index', true],
        ['/^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` (CHECK|FOREIGN KEY) /', 'constraint', true],
        ['/^CREATE TRIGGER `([^`]+)` /', 'trigger', true],
    ];

    private readonly Renderer $r;
    /** @var list<Plan> */
    private readonly array $chain;
    /** @var array<string, array{from: string, to: string, state: string, step: int}> plan 이름마다 history row */
    private array $history = [];

    /**
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    private function __construct(private readonly \PDO $c, string $dialect, array $plans, private readonly \Closure $now, private readonly ?\Closure $events)
    {
        $this->r = new Renderer($dialect);
        if ($c->getAttribute(\PDO::ATTR_ERRMODE) !== \PDO::ERRMODE_EXCEPTION) {
            throw new \InvalidArgumentException('apply needs a connection whose error mode is PDO::ERRMODE_EXCEPTION');
        }
        $chain = PlanChain::chain($plans);
        if ($chain->plans === null) {
            throw new ApplyError('chain', '', 0, $chain->diagnostics[0]->message);
        }
        $this->chain = $chain->plans;
    }

    /**
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function apply(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        $a = new self($c, $dialect, $plans, $now, $events);
        $a->locked(static function () use ($a): void {
            $position = $a->state();
            foreach (array_slice($a->chain, $position) as $plan) {
                $a->applyPlan($plan, 0, false);
            }
        });
    }

    /**
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function recover(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        $a = new self($c, $dialect, $plans, $now, $events);
        $a->locked(static function () use ($a): void {
            $a->readHistory();
            foreach ($a->chain as $plan) {
                $row = $a->history[$plan->name] ?? null;
                if ($row === null || $row['state'] !== 'running') {
                    continue;
                }
                if ($a->r->dialect !== 'mysql') {
                    throw new ApplyError('interrupted', $plan->name, $row['step'], 'only MySQL leaves a running plan; the row is not from apply');
                }
                $statements = $a->statements($plan);
                $start = $row['step'];
                if ($start < count($statements)) {
                    try {
                        $done = $a->mysqlEffect($statements[$start]);
                    } catch (\RuntimeException $e) {
                        throw new ApplyError('failed', $plan->name, $start, '', $e);
                    }
                    if ($done) {
                        $start++;
                    }
                }
                $a->applyPlan($plan, $start, true);
                return;
            }
        });
    }

    /**
     * dialect 의 lock 을 잡고 f 를 실행한다. SQLite 는 apply 전체를 한 transaction 으로
     * 실행하며 그 transaction 이 lock 이다. f 가 실패하면 그 error 를 돌려주고, 그때
     * lock 을 놓거나 rollback 하다 난 error 는 Go engine 처럼 버린다.
     *
     * @param \Closure(): void $f
     */
    private function locked(\Closure $f): void
    {
        $h = self::HISTORY;
        switch ($this->r->dialect) {
            case 'mysql':
                $got = $this->c->query("SELECT GET_LOCK('$h', 0)")->fetchColumn();
                if ($got !== 1 && $got !== '1') {
                    throw new ApplyError('locked', '', 0, "another session holds GET_LOCK('$h')");
                }
                $this->finish($f, fn(bool $ok) => $this->c->exec("DO RELEASE_LOCK('$h')"));
                return;
            case 'postgres':
                if ($this->c->query("SELECT pg_try_advisory_lock(hashtext('$h'))")->fetchColumn() !== true) {
                    throw new ApplyError('locked', '', 0, "another session holds the advisory lock of $h");
                }
                $this->finish($f, fn(bool $ok) => $this->c->query("SELECT pg_advisory_unlock(hashtext('$h'))")->fetchColumn());
                return;
        }
        $this->c->exec('PRAGMA foreign_keys = OFF');
        try {
            $this->c->exec('BEGIN IMMEDIATE');
        } catch (\PDOException $e) {
            $this->c->exec('PRAGMA foreign_keys = ON');
            throw new ApplyError('locked', '', 0, 'another connection holds the SQLite write lock', $e);
        }
        $this->finish($f, function (bool $ok): void {
            try {
                $this->c->exec($ok ? 'COMMIT' : 'ROLLBACK');
            } finally {
                $this->c->exec('PRAGMA foreign_keys = ON');
            }
        });
    }

    /**
     * f 를 실행하고 end(성공 여부) 로 마무리한다. f 의 error 가 end 의 error 보다 앞선다.
     *
     * @param \Closure(): void $f
     * @param \Closure(bool): mixed $end
     */
    private function finish(\Closure $f, \Closure $end): void
    {
        try {
            $f();
        } catch (\Throwable $e) {
            try {
                $end(false);
            } catch (\Throwable) {
                // Go engine 과 같이 앞선 error 를 돌려준다.
            }
            throw $e;
        }
        $end(true);
    }

    /** history table 을 없을 때 만든다. */
    private function createHistory(): void
    {
        $q = $this->r->q(...);
        [$integer, $text, $tail] = ['integer', 'varchar(71)', ''];
        if ($this->r->dialect === 'mysql') {
            [$integer, $text] = ['INT', 'varchar(71) CHARACTER SET ascii COLLATE ascii_bin'];
            $tail = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
        }
        $this->c->exec('CREATE TABLE IF NOT EXISTS ' . $q(self::HISTORY) . ' (' .
            $q('name') . " $text NOT NULL, " . $q('from_hash') . " $text NOT NULL, " . $q('to_hash') . " $text NOT NULL, " .
            $q('state') . " $text NOT NULL, " . $q('step') . " $integer NOT NULL, " . $q('steps') . " $integer NOT NULL, " .
            $q('applied_at') . " $text NOT NULL, PRIMARY KEY (" . $q('name') . '))' . $tail);
    }

    private function readHistory(): void
    {
        $this->createHistory();
        $q = $this->r->q(...);
        $query = 'SELECT ' . $q('name') . ', ' . $q('from_hash') . ', ' . $q('to_hash') . ', ' . $q('state') . ', ' . $q('step') . ' FROM ' . $q(self::HISTORY);
        $this->history = [];
        foreach (CatalogRows::read($this->c, $query) as $row) {
            $this->history[CatalogRows::text($row, 0, $query)] = [
                'from' => CatalogRows::text($row, 1, $query),
                'to' => CatalogRows::text($row, 2, $query),
                'state' => CatalogRows::text($row, 3, $query),
                'step' => CatalogRows::integer($row, 4, $query),
            ];
        }
    }

    /**
     * chain 에서 다음에 적용할 plan 의 위치. 기록이 chain 과 맞지 않거나, 중단된 plan 이
     * 있거나, catalog 가 기록한 schema 와 다르면 ApplyError 다.
     */
    private function state(): int
    {
        $this->readHistory();
        $position = 0;
        foreach ($this->chain as $i => $plan) {
            $row = $this->history[$plan->name] ?? null;
            if ($row === null) {
                continue;
            }
            if ($row['state'] === 'running') {
                throw new ApplyError('interrupted', $plan->name, $row['step'], 'run recover');
            }
            if ($row['to'] !== $plan->to || $row['from'] !== ($plan->from ?? 'empty')) {
                throw new ApplyError('chain', $plan->name, 0, "the recorded plan has other hashes than the chain's plan");
            }
            if ($i !== $position) {
                throw new ApplyError('chain', $plan->name, 0, 'a plan before it in the chain is not recorded');
            }
            $position = $i + 1;
        }
        if (count($this->history) !== $position) {
            throw new ApplyError('chain', '', 0, 'the history records a plan that is not in the chain');
        }
        try {
            $this->verify($position > 0 ? $this->chain[$position - 1]->to : '');
        } catch (\RuntimeException $e) {
            throw new ApplyError('drift', '', 0, '', $e);
        }
        return $position;
    }

    /** database 의 introspection 이 want schemaHash('' 이면 빈 database) 이고 미지원 객체가 없는지 확인한다. */
    private function verify(string $want): void
    {
        $result = Dbspec::introspect($this->c, $this->r->dialect, 'schema');
        if ($result->unsupported !== []) {
            $u = $result->unsupported[0];
            throw new \RuntimeException(sprintf('the database has %d objects that dbspec cannot express, first %s %s %s: %s', count($result->unsupported), $u->kind, $u->table, $u->name, $u->reason));
        }
        $got = '';
        if ($result->document->tables !== []) {
            $manifest = Dbspec::manifest([$result->document]);
            if ($manifest->manifest === null) {
                throw new \RuntimeException('the introspected schema is invalid: ' . json_encode(array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message], $manifest->diagnostics)));
            }
            $got = $manifest->manifest->schemaHash;
        }
        if ($got !== $want) {
            throw new \RuntimeException(sprintf('the database is at %s, not %s', $got === '' ? 'empty' : $got, $want === '' ? 'empty' : $want));
        }
    }

    /**
     * chain 에서 plan 의 앞 plan target 을 source 로 쓴 statement.
     *
     * @return list<string>
     */
    private function statements(Plan $plan): array
    {
        $source = null;
        foreach ($this->chain as $i => $p) {
            if ($p === $plan && $i > 0) {
                $source = $this->chain[$i - 1]->schema;
            }
        }
        $result = Dbspec::planStatements($source, $plan, $this->r->dialect);
        if ($result->statements === null) {
            throw new ApplyError('chain', $plan->name, 0, $result->diagnostics[0]->message);
        }
        return $result->statements;
    }

    /** plan 하나를 start 번째 statement 부터 적용하고 검증한다. resume 이면 기록된 running row 를 이어 쓴다. */
    private function applyPlan(Plan $plan, int $start, bool $resume): void
    {
        $statements = $this->statements($plan);
        $this->emit(new ApplyEvent('plan', $plan->name, 0, count($statements), ''));
        if ($this->r->dialect === 'postgres') {
            $this->c->exec('BEGIN');
            $this->finish(fn() => $this->runPlan($plan, $statements, $start, $resume), fn(bool $ok) => $this->c->exec($ok ? 'COMMIT' : 'ROLLBACK'));
        } else {
            $this->runPlan($plan, $statements, $start, $resume);
        }
        $this->emit(new ApplyEvent('done', $plan->name, 0, count($statements), ''));
    }

    /** @param list<string> $statements */
    private function runPlan(Plan $plan, array $statements, int $start, bool $resume): void
    {
        $q = $this->r->q(...);
        $steps = count($statements);
        if (!$resume) {
            $appliedAt = \DateTimeImmutable::createFromInterface(($this->now)())->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z');
            $this->c->prepare('INSERT INTO ' . $q(self::HISTORY) . ' (' . $q('name') . ', ' . $q('from_hash') . ', ' . $q('to_hash') . ', ' .
                $q('state') . ', ' . $q('step') . ', ' . $q('steps') . ', ' . $q('applied_at') . ') VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$plan->name, $plan->from ?? 'empty', $plan->to, 'running', 0, $steps, $appliedAt]);
        }
        $step = function (int $n) use ($q, $plan): void {
            $this->c->prepare('UPDATE ' . $q(self::HISTORY) . ' SET ' . $q('step') . ' = ? WHERE ' . $q('name') . ' = ?')->execute([$n, $plan->name]);
        };
        if ($resume) {
            $step($start);
        }
        for ($i = $start; $i < $steps; $i++) {
            $this->emit(new ApplyEvent('statement', $plan->name, $i, $steps, $statements[$i]));
            try {
                $this->c->exec($statements[$i]);
            } catch (\PDOException $e) {
                throw new ApplyError('failed', $plan->name, $i, $statements[$i], $e);
            }
            $this->emit(new ApplyEvent('applied', $plan->name, $i, $steps, $statements[$i]));
            $step($i + 1);
        }
        if ($this->r->dialect === 'sqlite') {
            $query = 'SELECT COUNT(*) FROM pragma_foreign_key_check';
            $broken = CatalogRows::integer(CatalogRows::read($this->c, $query)[0], 0, $query);
            if ($broken > 0) {
                throw new ApplyError('verify', $plan->name, 0, "$broken rows break a foreign key");
            }
        }
        try {
            $this->verify($plan->to);
        } catch (\RuntimeException $e) {
            throw new ApplyError('verify', $plan->name, 0, '', $e);
        }
        $this->emit(new ApplyEvent('verified', $plan->name, 0, $steps, ''));
        $this->c->prepare('UPDATE ' . $q(self::HISTORY) . ' SET ' . $q('state') . " = 'done' WHERE " . $q('name') . ' = ?')->execute([$plan->name]);
    }

    private function emit(ApplyEvent $event): void
    {
        if ($this->events !== null) {
            ($this->events)($event);
        }
    }

    /** statement 의 효과가 catalog 에 있는지 알려 준다. */
    private function mysqlEffect(string $statement): bool
    {
        foreach (self::MYSQL_EFFECTS as [$pattern, $kind, $present]) {
            if (preg_match($pattern, $statement, $m) !== 1) {
                continue;
            }
            [$query, $args] = match ($kind) {
                'repeat' => [null, []],
                'trigger' => ['SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?', [$m[1]]],
                'table' => ['SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [$m[1]]],
                'column' => ['SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [$m[1], $m[2]]],
                'constraint' => ['SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [$m[1], $m[2]]],
                'index' => ['SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [$m[1], $m[2]]],
                'index_on' => ['SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [$m[2], $m[1]]],
            };
            if ($query === null) {
                return false;
            }
            $s = $this->c->prepare($query);
            $s->execute($args);
            $n = CatalogRows::integer([$s->fetchColumn()], 0, $query);
            return ($n > 0) === $present;
        }
        throw new \RuntimeException("statement \"$statement\" has no known effect");
    }
}
