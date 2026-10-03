<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * plan chain 을 connection 하나에 step 하나씩 적용하고, 중단된 plan 을 이어 가거나
 * 되돌리고, 적용한 plan 을 finalize 한다(docs/plans.md "Apply"). 객체 하나가 명령 한
 * 번의 상태다.
 *
 * @internal
 */
final class PlanApply
{
    /** 적용한 plan 을 기록하는 table. dbspec 이름에는 $ 가 없으므로 사용자 table 과 겹치지 않고, introspection 은 dbspec$ 로 시작하는 table 을 빼고 읽는다. */
    private const HISTORY = 'dbspec$plans';
    // 현재 database 하나의 lock 이름. MySQL lock 이름은 64자까지이므로 database
    // 이름 대신 그 SHA-256 hex 앞 51자를 붙여 64자로 만든다.
    private const MYSQL_LOCK = "CONCAT('dbspec\$plans\$', LEFT(SHA2(DATABASE(), 256), 51))";
    // 현재 database 의 현재 schema 하나의 advisory lock key.
    private const POSTGRES_LOCK = "hashtext('dbspec\$plans'), hashtext(current_schema())";
    // session error 가 밝히는 요구. lock 은 server session 에 속하므로 명령은 처음부터 끝까지 다른
    // client 와 나누지 않는 server session 하나에서 실행해야 한다. transaction pooler 는 statement 마다
    // server connection 을 다시 고르므로 그 요구를 지키지 못한다.
    private const SESSION_REQUIREMENT = 'apply, recover, rollback and finalize need one server session of their own for the whole run: a direct or session-pooled connection';
    // 현재 server session 의 id 와, 그 session 이 이 명령의 lock 을 이미 잡고 있는지를 읽는다. lock 을
    // 잡기 전에 이미 잡혀 있으면 다른 client 가 같은 server session 을 쓰고 있다.
    private const SESSION_QUERIES = [
        'mysql' => 'SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK(' . self::MYSQL_LOCK . ') = CONNECTION_ID(), 0)',
        'postgres' => "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objsubid = 2"
            . " AND classid = (hashtext('dbspec\$plans')::bigint & 4294967295)::oid AND objid = (hashtext(current_schema())::bigint & 4294967295)::oid)",
    ];
    // statement 가 다른 session 의 lock 을 기다리는 최대 시간(docs/plans.md "Apply"의 lock 대기).
    private const LOCK_WAIT_SECONDS = 5;

    private const APPLYING = 'applying';
    private const APPLIED = 'applied';
    private const FINALIZING = 'finalizing';
    private const DONE = 'done';
    private const ROLLING_BACK = 'rolling_back';

    /**
     * dialect 마다 효과 종류를 읽는 query 다. 인자는 Effect 의 table 과 name 중 query
     * 가 쓰는 것이며, query 는 개수를 돌려준다.
     */
    public const EFFECT_QUERIES = [
        'mysql' => [
            'table' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
            'column' => 'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            'index' => 'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
            'constraint' => 'SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?',
            'trigger' => 'SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?',
        ],
        'postgres' => [
            'table' => "SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') AND relname = ?",
            'column' => 'SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND a.attname = ? AND a.attnum > 0 AND NOT a.attisdropped',
            'index' => 'SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND i.relname = ?',
            'constraint' => 'SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND k.conname = ?',
            'trigger' => 'SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND g.tgname = ? AND NOT g.tgisinternal',
            'function' => 'SELECT COUNT(*) FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname = ?',
        ],
        'sqlite' => [
            'table' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            'column' => 'SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?',
            'index' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?",
            'trigger' => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name = ?",
            'sequence' => 'SELECT COUNT(*) FROM sqlite_sequence WHERE name = ?',
        ],
    ];

    private readonly Renderer $r;
    /** @var list<Plan> */
    private readonly array $chain;
    /** @var array<string, array{from: string, to: string, state: string, step: int}> plan 이름마다 history row */
    private array $history = [];
    /** lock 을 잡은 server session 의 id(MySQL CONNECTION_ID, PostgreSQL pg_backend_pid). */
    private int $serverSession = 0;

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
        $a->session(static function () use ($a): void {
            $position = $a->settled();
            foreach (array_slice($a->chain, $position) as $plan) {
                $a->applyPlan($plan);
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
        $a->session(static function () use ($a): void {
            $position = $a->position();
            if ($position === 0) {
                return;
            }
            $plan = $a->chain[$position - 1];
            $row = $a->history[$plan->name];
            if ($row['state'] === self::APPLIED || $row['state'] === self::DONE) {
                return;
            }
            $steps = $a->steps($plan);
            $k = $a->resolve($plan, $row, $steps, true);
            if ($row['state'] === self::FINALIZING) {
                $a->emit(new ApplyEvent('finalize', $plan->name, 0, count($steps), ''));
                $a->finalizeFrom($plan, $steps, $k);
                return;
            }
            $a->emit(new ApplyEvent('plan', $plan->name, 0, count($steps), ''));
            $a->record($plan, self::APPLYING, $k);
            $a->forward($plan, $steps, $k);
        });
    }

    /**
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function rollback(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        $a = new self($c, $dialect, $plans, $now, $events);
        $a->session(static function () use ($a): void {
            $position = $a->position();
            if ($position === 0) {
                return;
            }
            $plan = $a->chain[$position - 1];
            $row = $a->history[$plan->name];
            $steps = $a->steps($plan);
            $k = $row['step'];
            $applied = $row['state'] === self::APPLIED || $row['state'] === self::DONE;
            if ($applied) {
                try {
                    $a->verify($plan->to);
                } catch (\RuntimeException $e) {
                    throw new ApplyError('drift', $plan->name, 0, $e->getMessage());
                }
            } else {
                $k = $a->resolve($plan, $row, $steps, false);
            }
            if ($k > 0 && $steps[$k - 1]->rollback === '') {
                throw $a->irreversible($plan, $steps, $k - 1);
            }
            if ($applied) {
                $a->nullChecks($plan, array_slice($steps, 0, $k));
            }
            $a->emit(new ApplyEvent('rollback', $plan->name, 0, count($steps), ''));
            $a->record($plan, self::ROLLING_BACK, $k);
            for ($i = $k - 1; $i >= 0; $i--) {
                $step = $steps[$i];
                if ($step->rollback === '') {
                    throw $a->irreversible($plan, $steps, $i);
                }
                $statement = $step->rollback;
                if ($step->rollbackRestore !== '' && $a->effect($plan, $i, $step->restoreIf)) {
                    $statement = $step->rollbackRestore;
                }
                $a->run($plan, $steps, $i, $statement);
                $a->setStep($plan, $i);
            }
            $a->foreignKeyCheck($plan);
            try {
                $a->verify($plan->from ?? '');
            } catch (\RuntimeException $e) {
                throw new ApplyError('verify', $plan->name, 0, '', $e);
            }
            $a->emit(new ApplyEvent('verified', $plan->name, 0, count($steps), ''));
            $q = $a->r->q(...);
            $a->c->prepare('DELETE FROM ' . $q(self::HISTORY) . ' WHERE ' . $q('name') . ' = ?')->execute([$plan->name]);
            $a->emit(new ApplyEvent('done', $plan->name, 0, count($steps), ''));
        });
    }

    /**
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     */
    public static function finalize(\PDO $c, string $dialect, array $plans, \Closure $now, ?\Closure $events): void
    {
        $a = new self($c, $dialect, $plans, $now, $events);
        $a->session(static function () use ($a): void {
            $position = $a->settled();
            foreach (array_slice($a->chain, 0, $position) as $plan) {
                if ($a->history[$plan->name]['state'] !== self::APPLIED) {
                    continue;
                }
                $steps = $a->steps($plan);
                $a->emit(new ApplyEvent('finalize', $plan->name, 0, count($steps), ''));
                $start = self::finalizeStart($steps);
                $a->record($plan, self::FINALIZING, $start);
                $a->finalizeFrom($plan, $steps, $start);
            }
        });
    }

    /**
     * 첫 finalize step 의 index.
     *
     * @param list<PlanStep> $steps
     */
    private static function finalizeStart(array $steps): int
    {
        foreach ($steps as $i => $s) {
            if ($s->finalize) {
                return $i;
            }
        }
        return count($steps);
    }

    /** @param list<PlanStep> $steps */
    private function irreversible(Plan $plan, array $steps, int $i): ApplyError
    {
        return new ApplyError('irreversible', $plan->name, $i, $steps[$i]->finalize ? 'a finalize step has no rollback' : $steps[$i]->irreversible);
    }

    /**
     * dialect 의 lock 을 잡고 session 설정을 바꾼 뒤 f 를 실행하고, 끝에 설정을 되돌리고
     * lock 을 놓는다. f 가 실패해도 정리를 모두 실행하며, 그때 난 error 는 finish 가 f 의
     * error 와 함께 던진다.
     *
     * @param \Closure(): void $f
     */
    private function session(\Closure $f): void
    {
        $h = self::HISTORY;
        $wait = self::LOCK_WAIT_SECONDS;
        switch ($this->r->dialect) {
            case 'mysql':
                $this->openSession(self::SESSION_QUERIES['mysql']);
                // GET_LOCK 의 NULL 은 lock 을 기다리던 중의 error 다.
                [$got, $current] = $this->queryRow('SELECT GET_LOCK(' . self::MYSQL_LOCK . ', 0), CONNECTION_ID()');
                if ($got === 0 || $got === '0') {
                    throw new ApplyError('locked', '', 0, "another session holds the $h lock of this database");
                }
                if ($got !== 1 && $got !== '1') {
                    throw new \RuntimeException('GET_LOCK returned ' . var_export($got, true) . '; want 1 or 0');
                }
                $previous = null;
                $this->finish(function () use ($f, $wait, &$previous, $current): void {
                    $this->sameSession(null, 0, $current);
                    $query = 'SELECT @@SESSION.lock_wait_timeout, @@SESSION.innodb_lock_wait_timeout';
                    $row = $this->queryRow($query);
                    $values = [CatalogRows::integer($row, 0, $query), CatalogRows::integer($row, 1, $query)];
                    $this->c->exec("SET SESSION lock_wait_timeout = $wait, innodb_lock_wait_timeout = $wait");
                    $previous = $values;
                    $f();
                }, function () use (&$previous): void {
                    if ($previous !== null) {
                        $this->c->exec("SET SESSION lock_wait_timeout = {$previous[0]}, innodb_lock_wait_timeout = {$previous[1]}");
                    }
                }, fn() => $this->c->exec('DO RELEASE_LOCK(' . self::MYSQL_LOCK . ')'));
                return;
            case 'postgres':
                // current_schema() 가 NULL 이면 결과도 NULL 이며 error 다.
                $this->openSession(self::SESSION_QUERIES['postgres']);
                [$got, $current] = $this->queryRow('SELECT pg_try_advisory_lock(' . self::POSTGRES_LOCK . '), pg_backend_pid()');
                if ($got === false) {
                    throw new ApplyError('locked', '', 0, "another session holds the $h advisory lock of this schema");
                }
                if ($got !== true) {
                    throw new \RuntimeException('pg_try_advisory_lock returned ' . var_export($got, true) . '; want true or false');
                }
                $previous = null;
                $this->finish(function () use ($f, $wait, &$previous, $current): void {
                    $this->sameSession(null, 0, $current);
                    $value = $this->queryValue("SELECT current_setting('lock_timeout')");
                    $this->queryValue("SELECT set_config('lock_timeout', '{$wait}s', false)");
                    $previous = (string) $value;
                    $f();
                }, function () use (&$previous): void {
                    if ($previous !== null) {
                        $this->queryValue("SELECT set_config('lock_timeout', ?, false)", [$previous]);
                    }
                }, function () use ($h): void {
                    $released = $this->queryValue('SELECT pg_advisory_unlock(' . self::POSTGRES_LOCK . ')');
                    if ($released === false) {
                        throw new \RuntimeException("the advisory lock of $h was not held at unlock");
                    }
                    if ($released !== true) {
                        throw new \RuntimeException('pg_advisory_unlock returned ' . var_export($released, true) . '; want true or false');
                    }
                });
                return;
        }
        $this->sqliteSession($f);
    }

    /**
     * SQLite 의 exclusive locking mode 로 file 을 잠그고, foreign key 를 끄고, 이름
     * 바꾸기가 다른 table 의 foreign key 를 데려가게 한다.
     *
     * @param \Closure(): void $f
     */
    private function sqliteSession(\Closure $f): void
    {
        $foreignKeys = CatalogRows::integer([$this->queryValue('PRAGMA foreign_keys')], 0, 'PRAGMA foreign_keys');
        $legacy = CatalogRows::integer([$this->queryValue('PRAGMA legacy_alter_table')], 0, 'PRAGMA legacy_alter_table');
        $busy = CatalogRows::integer([$this->queryValue('PRAGMA busy_timeout')], 0, 'PRAGMA busy_timeout');
        $mode = CatalogRows::text([$this->queryValue('PRAGMA locking_mode')], 0, 'PRAGMA locking_mode');
        $this->c->exec('PRAGMA busy_timeout = ' . (self::LOCK_WAIT_SECONDS * 1000));
        $this->finish(function () use ($f): void {
            $this->c->exec('PRAGMA locking_mode = EXCLUSIVE');
            try {
                $this->c->exec('BEGIN EXCLUSIVE');
            } catch (\PDOException $e) {
                throw new ApplyError('locked', '', 0, 'another connection holds the SQLite database', $e);
            }
            $this->c->exec('COMMIT');
            $this->c->exec('PRAGMA foreign_keys = OFF');
            $this->c->exec('PRAGMA legacy_alter_table = OFF');
            $f();
        }, fn() => $this->c->exec("PRAGMA foreign_keys = $foreignKeys"),
            fn() => $this->c->exec("PRAGMA legacy_alter_table = $legacy"),
            fn() => $this->c->exec("PRAGMA locking_mode = $mode"),
            // locking mode 를 되돌린 뒤 한 번 읽어야 exclusive lock 이 풀린다.
            fn() => $this->queryValue('SELECT COUNT(*) FROM sqlite_master'),
            fn() => $this->c->exec("PRAGMA busy_timeout = $busy"));
    }

    /**
     * f 를 실행한 뒤 end 를 앞의 실패와 상관없이 차례로 모두 실행한다. error 가 하나면
     * 그것을 그대로 던지고, 여럿이면 첫 error 와 그 뒤의 정리 error 를 함께 담은
     * ApplyCleanupError 를 던진다.
     *
     * @param \Closure(): void $f
     * @param \Closure(): mixed ...$ends
     */
    private function finish(\Closure $f, \Closure ...$ends): void
    {
        $errors = [];
        try {
            $f();
        } catch (ApplyCleanupError $e) {
            // 안쪽 정리 error 는 순서를 지켜 한 목록으로 편다.
            $errors[] = $e->getPrevious();
            array_push($errors, ...$e->cleanup);
        } catch (\Throwable $e) {
            $errors[] = $e;
        }
        foreach ($ends as $end) {
            try {
                $end();
            } catch (\Throwable $e) {
                $errors[] = $e;
            }
        }
        if (count($errors) === 1) {
            throw $errors[0];
        }
        if ($errors !== []) {
            throw new ApplyCleanupError($errors[0], array_slice($errors, 1));
        }
    }

    /**
     * query 가 돌려준 첫 row. row 가 없거나 result 를 닫지 못하면 error 다.
     *
     * @param list<mixed> $args
     * @return list<mixed>
     */
    private function queryRow(string $query, array $args = []): array
    {
        $s = $this->c->prepare($query);
        $row = false;
        $this->finish(function () use ($s, $args, $query, &$row): void {
            $s->execute($args);
            $row = $s->fetch(\PDO::FETCH_NUM);
            if ($row === false) {
                throw new \RuntimeException("$query returned no row");
            }
        }, function () use ($s, $query): void {
            if (!$s->closeCursor()) {
                throw new \RuntimeException("closing the result of $query failed");
            }
        });
        return $row;
    }

    /**
     * query 가 돌려준 첫 row 의 첫 값.
     *
     * @param list<mixed> $args
     */
    private function queryValue(string $query, array $args = []): mixed
    {
        return $this->queryRow($query, $args)[0];
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
     * history 를 읽어 기록된 plan 수를 돌려준다. 기록은 chain 의 앞부분이어야 하고,
     * 마지막 앞의 row 는 applied 나 done 이어야 한다.
     */
    private function position(): int
    {
        $this->readHistory();
        $position = 0;
        foreach ($this->chain as $i => $plan) {
            $row = $this->history[$plan->name] ?? null;
            if ($row === null) {
                continue;
            }
            if ($row['to'] !== $plan->to || $row['from'] !== ($plan->from ?? 'empty')) {
                throw new ApplyError('chain', $plan->name, 0, "the recorded plan has other hashes than the chain's plan");
            }
            if ($i !== $position) {
                throw new ApplyError('chain', $plan->name, 0, 'a plan before it in the chain is not recorded');
            }
            if (!in_array($row['state'], [self::APPLYING, self::APPLIED, self::FINALIZING, self::DONE, self::ROLLING_BACK], true)) {
                throw new ApplyError('chain', $plan->name, 0, "the recorded state {$row['state']} is not a history state");
            }
            $position = $i + 1;
        }
        if (count($this->history) !== $position) {
            throw new ApplyError('chain', '', 0, 'the history records a plan that is not in the chain');
        }
        foreach (array_slice($this->chain, 0, max($position - 1, 0)) as $plan) {
            $state = $this->history[$plan->name]['state'];
            if ($state !== self::APPLIED && $state !== self::DONE) {
                throw new ApplyError('chain', $plan->name, 0, "a plan before the last is $state");
            }
        }
        return $position;
    }

    /** 중단된 plan 이 없고 catalog 가 기록한 schema 와 같을 때 기록된 plan 수를 돌려준다. */
    private function settled(): int
    {
        $position = $this->position();
        $want = '';
        if ($position > 0) {
            $plan = $this->chain[$position - 1];
            $row = $this->history[$plan->name];
            if ($row['state'] !== self::APPLIED && $row['state'] !== self::DONE) {
                throw new ApplyError('interrupted', $plan->name, $row['step'], "the plan is {$row['state']}; run recover or rollback");
            }
            $want = $plan->to;
        }
        try {
            $this->verify($want);
        } catch (\RuntimeException $e) {
            throw new ApplyError('drift', '', 0, $e->getMessage());
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
     * chain 에서 plan 의 앞 plan target 을 source 로 쓴 step.
     *
     * @return list<PlanStep>
     */
    private function steps(Plan $plan): array
    {
        $source = null;
        foreach ($this->chain as $i => $p) {
            if ($p === $plan && $i > 0) {
                $source = $this->chain[$i - 1]->schema;
            }
        }
        $result = Dbspec::planSteps($source, $plan, $this->r->dialect);
        if ($result->steps === null) {
            throw new ApplyError('chain', $plan->name, 0, $result->diagnostics[0]->message);
        }
        return $result->steps;
    }

    /**
     * 중단된 row 의 step 을 catalog 의 효과로 정한다. forward 이면 앞으로, 아니면 뒤로
     * 이어 갈 위치다(docs/plans.md "Apply"의 recover).
     *
     * @param array{from: string, to: string, state: string, step: int} $row
     * @param list<PlanStep> $steps
     */
    private function resolve(Plan $plan, array $row, array $steps, bool $forward): int
    {
        $k = $row['step'];
        if ($k < 0 || $k > count($steps)) {
            throw new ApplyError('chain', $plan->name, 0, sprintf("the recorded step %d is outside the plan's %d steps", $k, count($steps)));
        }
        $rolling = $row['state'] === self::ROLLING_BACK;
        $uncertain = $rolling ? $k - 1 : $k;
        if ($uncertain < 0 || $uncertain >= count($steps)) {
            return $k;
        }
        $e = $steps[$uncertain]->effect;
        $held = $e->kind !== 'repeat' && $this->effect($plan, $uncertain, $e);
        // 앞으로 갈 때 repeat step 은 다시 실행하고, 뒤로 갈 때는 그 rollback 을 다시 실행한다.
        $took = $held || (!$forward && $e->kind === 'repeat');
        if ($rolling) {
            return $took ? $k : $k - 1;
        }
        return $took ? $k + 1 : $k;
    }

    /** plan 의 row 를 state 와 step 으로 쓴다. row 가 없으면 만든다. */
    private function record(Plan $plan, string $state, int $step): void
    {
        $q = $this->r->q(...);
        if (!isset($this->history[$plan->name])) {
            $steps = count($this->steps($plan));
            // applied_at은 tool clock의 UTC 시각을 소수 여섯 자리로 버림한 text다(docs/plans.md "Apply").
            $appliedAt = \DateTimeImmutable::createFromInterface(($this->now)())->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.u\Z');
            $this->c->prepare('INSERT INTO ' . $q(self::HISTORY) . ' (' . $q('name') . ', ' . $q('from_hash') . ', ' . $q('to_hash') . ', ' .
                $q('state') . ', ' . $q('step') . ', ' . $q('steps') . ', ' . $q('applied_at') . ') VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$plan->name, $plan->from ?? 'empty', $plan->to, $state, $step, $steps, $appliedAt]);
            $this->history[$plan->name] = ['from' => $plan->from ?? 'empty', 'to' => $plan->to, 'state' => $state, 'step' => $step];
            return;
        }
        $this->c->prepare('UPDATE ' . $q(self::HISTORY) . ' SET ' . $q('state') . ' = ?, ' . $q('step') . ' = ? WHERE ' . $q('name') . ' = ?')
            ->execute([$state, $step, $plan->name]);
    }

    private function setStep(Plan $plan, int $step): void
    {
        $q = $this->r->q(...);
        $this->c->prepare('UPDATE ' . $q(self::HISTORY) . ' SET ' . $q('step') . ' = ? WHERE ' . $q('name') . ' = ?')->execute([$step, $plan->name]);
    }

    /** plan 하나를 finalize step 앞까지 적용하고 검증한다. */
    private function applyPlan(Plan $plan): void
    {
        $steps = $this->steps($plan);
        $this->emit(new ApplyEvent('plan', $plan->name, 0, count($steps), ''));
        foreach (array_slice($steps, 0, self::finalizeStart($steps)) as $i => $s) {
            if ($s->rollback === '') {
                $this->emit(new ApplyEvent('irreversible', $plan->name, $i, count($steps), $s->statement));
            }
        }
        $this->record($plan, self::APPLYING, 0);
        $this->forward($plan, $steps, 0);
    }

    /**
     * step start 부터 finalize step 앞까지 실행하고 검증한 뒤 row 를 applied 로 바꾼다.
     *
     * @param list<PlanStep> $steps
     */
    private function forward(Plan $plan, array $steps, int $start): void
    {
        $end = self::finalizeStart($steps);
        for ($i = $start; $i < $end; $i++) {
            $step = $steps[$i];
            $statement = $step->statement;
            if ($step->restore !== '' && $this->effect($plan, $i, $step->restoreIf)) {
                $statement = $step->restore;
            }
            $this->run($plan, $steps, $i, $statement);
            $this->setStep($plan, $i + 1);
        }
        $this->foreignKeyCheck($plan);
        try {
            $this->verify($plan->to);
        } catch (\RuntimeException $e) {
            throw new ApplyError('verify', $plan->name, 0, '', $e);
        }
        $this->emit(new ApplyEvent('verified', $plan->name, 0, count($steps), ''));
        $this->record($plan, self::APPLIED, $end);
        $this->emit(new ApplyEvent('done', $plan->name, 0, count($steps), ''));
    }

    /**
     * finalize step 을 start 부터 실행하고 row 를 done 으로 바꾼다.
     *
     * @param list<PlanStep> $steps
     */
    private function finalizeFrom(Plan $plan, array $steps, int $start): void
    {
        for ($i = $start; $i < count($steps); $i++) {
            $this->run($plan, $steps, $i, $steps[$i]->statement);
            $this->setStep($plan, $i + 1);
        }
        $this->record($plan, self::DONE, count($steps));
        $this->emit(new ApplyEvent('done', $plan->name, 0, count($steps), ''));
    }

    /**
     * lock 을 잡기 전에 server session 의 id 를 기억한다. 그 session 이 lock 을 이미 잡고 있으면 다른
     * client 가 같은 server session 을 쓰는 것이므로 session error 다.
     */
    private function openSession(string $query): void
    {
        $row = $this->queryRow($query);
        $this->serverSession = CatalogRows::integer($row, 0, $query);
        if ($row[1] === true || $row[1] === 1 || $row[1] === '1') {
            throw new ApplyError('session', '', 0, 'this server session already holds the ' . self::HISTORY . ' lock, so another client shares it; ' . self::SESSION_REQUIREMENT);
        }
    }

    /** current 가 lock 을 잡은 server session 인지 확인한다. 다르면 plan 의 step i 앞에서(plan 이 null 이면 lock 에서) session error 다. */
    private function sameSession(?Plan $plan, int $i, mixed $current): void
    {
        $id = CatalogRows::integer([$current], 0, 'server session id');
        if ($id === $this->serverSession) {
            return;
        }
        throw new ApplyError('session', $plan?->name ?? '', $plan === null ? 0 : $i, "the connection moved from server session {$this->serverSession} to $id; " . self::SESSION_REQUIREMENT);
    }

    /**
     * step i 의 statement 하나를 event 와 함께 실행한다. statement 앞에서 server session 을
     * 확인한다(SQLite 는 file 하나의 connection 이다).
     *
     * @param list<PlanStep> $steps
     */
    private function run(Plan $plan, array $steps, int $i, string $statement): void
    {
        $this->emit(new ApplyEvent('statement', $plan->name, $i, count($steps), $statement));
        if ($this->r->dialect !== 'sqlite') {
            $query = $this->r->dialect === 'mysql' ? 'SELECT CONNECTION_ID()' : 'SELECT pg_backend_pid()';
            try {
                $current = $this->queryValue($query);
            } catch (\PDOException $e) {
                throw new ApplyError('failed', $plan->name, $i, $query, $e);
            }
            $this->sameSession($plan, $i, $current);
        }
        try {
            $this->c->exec($statement);
        } catch (\PDOException $e) {
            throw new ApplyError('failed', $plan->name, $i, $statement, $e);
        }
        $this->emit(new ApplyEvent('applied', $plan->name, $i, count($steps), $statement));
    }

    /** SQLite 에서 foreign key 를 어기는 row 가 없는지 확인한다. */
    private function foreignKeyCheck(Plan $plan): void
    {
        if ($this->r->dialect !== 'sqlite') {
            return;
        }
        $query = 'SELECT COUNT(*) FROM pragma_foreign_key_check';
        $broken = CatalogRows::integer([$this->queryValue($query)], 0, $query);
        if ($broken > 0) {
            throw new ApplyError('verify', $plan->name, 0, "$broken rows break a foreign key");
        }
    }

    /**
     * 적용한 plan 의 rollback 이 non-null 로 되돌릴 column 의 NULL row 를 default 로
     * 채우거나, default 가 없으면 nulls error 로 멈춘다(docs/plans.md "Steps").
     *
     * @param list<PlanStep> $steps
     */
    private function nullChecks(Plan $plan, array $steps): void
    {
        $q = $this->r->q(...);
        foreach ($steps as $i => $s) {
            foreach ($s->nullChecks as $check) {
                $query = 'SELECT COUNT(*) FROM ' . $q($check->table) . ' WHERE ' . $q($check->column) . ' IS NULL';
                $n = CatalogRows::integer([$this->queryValue($query)], 0, $query);
                if ($n === 0) {
                    continue;
                }
                if ($check->default === null) {
                    throw new ApplyError('nulls', $plan->name, $i, sprintf('column %s.%s has %d NULL rows and no default to restore NOT NULL', $check->table, $check->column, $n));
                }
                $this->c->exec('UPDATE ' . $q($check->table) . ' SET ' . $q($check->column) . ' = ' . $check->default . ' WHERE ' . $q($check->column) . ' IS NULL');
            }
        }
    }

    private function emit(ApplyEvent $event): void
    {
        if ($this->events !== null) {
            ($this->events)($event);
        }
    }

    /** 효과가 지금 database 에 있는지 알려 준다. 읽지 못하면 step 의 failed error 다. */
    private function effect(Plan $plan, int $step, ?Effect $e): bool
    {
        if ($e === null) {
            throw new \LogicException("step $step has no effect to read");
        }
        try {
            return $this->effectHolds($e);
        } catch (\RuntimeException $err) {
            throw new ApplyError('failed', $plan->name, $step, '', $err);
        }
    }

    public function effectHolds(Effect $e): bool
    {
        if ($e->kind === 'rows') {
            $query = 'SELECT COUNT(*) FROM (SELECT 1 FROM ' . $this->r->q($e->table) . ' LIMIT 1) x';
            $args = [];
        } else {
            $query = self::EFFECT_QUERIES[$this->r->dialect][$e->kind] ?? throw new \RuntimeException("the effect {$e->text()} has no query on {$this->r->dialect}");
            $args = match ($e->kind) {
                'table', 'sequence' => [$e->table],
                'function' => [$e->name],
                default => [$e->table, $e->name],
            };
        }
        $n = CatalogRows::integer([$this->queryValue($query, $args)], 0, $query);
        return ($n > 0) === $e->present;
    }

    /**
     * 효과 하나를 읽는 test 용 입구다(dbspec_apply_cleanup_test.php).
     *
     * @internal
     */
    public static function effectOn(\PDO $c, string $dialect, Effect $e): bool
    {
        return (new self($c, $dialect, [], static fn() => new \DateTimeImmutable(), null))->effectHolds($e);
    }
}
