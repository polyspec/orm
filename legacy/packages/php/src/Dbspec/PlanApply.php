<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Applies a plan chain to one connection, one step at a time; resumes or undoes an interrupted plan,
 * and finalizes an applied plan (docs/spec/plans.md "Apply"). One object is the state of one command
 * per command.
 *
 * @phpstan-import-type PlanList from Dbspec
 * @phpstan-import-type PlanClock from Dbspec
 * @phpstan-import-type PlanEventHandler from Dbspec
 * @phpstan-type PlanSessionOperation \Closure(PlanApply): void
 * @internal
 */
final class PlanApply
{
    /**
     * The table that records applied plans. Dbspec names have no $, so it does not overlap user tables, and
     * introspection reads without the tables starting with dbspec$.
     */
    private const HISTORY = 'dbspec$plans';
    // The lock name of the current database. MySQL lock names are up to 64 characters, so for a database
    // the name is made 64 characters by appending the first 51 characters of its SHA-256 hex.
    private const MYSQL_LOCK = "CONCAT('dbspec\$plans\$', LEFT(SHA2(DATABASE(), 256), 51))";
    // The advisory lock key of the current schema of the current database.
    private const POSTGRES_LOCK = "hashtext('dbspec\$plans'), hashtext(current_schema())";
    // A requirement that the session error states. The lock belongs to the server session, so the command
    // must run from start to finish on one server session not shared with another client. A transaction
    // pooler reselects the server connection for every statement, so it cannot keep that requirement.
    private const SESSION_REQUIREMENT = 'apply, recover, rollback and finalize need one server session of their own '
        . 'for the whole run: a direct or session-pooled connection';
    // Reads the id of the current server session, and whether that session already holds this command's lock.
    // Before the lock is taken, if it is already held, another client is using the same server session.
    private const SESSION_QUERIES = [
        'mysql' => 'SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK(' . self::MYSQL_LOCK . ') = CONNECTION_ID(), 0)',
        'postgres' => "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND "
            . "pid = pg_backend_pid() AND objsubid = 2"
            . " AND classid = (hashtext('dbspec\$plans')::bigint & 4294967295)::oid AND "
            . "objid = (hashtext(current_schema())::bigint & 4294967295)::oid)",
    ];
    // The savepoint of the SQLite rebuild of a table in the text storage of a uuid (PLN-110).
    private const CONVERT_SAVEPOINT = '"dbspec$convert"';
    // The maximum time a statement waits for another session's lock (the lock wait in docs/spec/plans.md "Apply").
    private const LOCK_WAIT_SECONDS = 5;

    private const APPLYING = 'applying';
    private const APPLIED = 'applied';
    private const FINALIZING = 'finalizing';
    private const DONE = 'done';
    private const ROLLING_BACK = 'rolling_back';

    /**
     * A query that reads the effect kind, per dialect. The arguments are the table and name of Effect; the query
     * uses whichever it writes, and the query returns a count.
     */
    public const EFFECT_QUERIES = [
        'mysql' => [
            'table' => 'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() '
                . 'AND TABLE_NAME = ?',
            'column' => 'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() '
                . 'AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            'index' => 'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() '
                . 'AND TABLE_NAME = ? AND INDEX_NAME = ?',
            'constraint' => 'SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = '
                . 'DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?',
            'trigger' => 'SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = DATABASE() '
                . 'AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?',
        ],
        'postgres' => [
            'table' => "SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace "
                . "AND relkind IN ('r', 'p') AND relname = ?",
            'column' => 'SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE '
                . 'c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND a.attname = ? AND '
                . 'a.attnum > 0 AND NOT a.attisdropped',
            'index' => 'SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c '
                . 'ON c.oid = x.indrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? '
                . 'AND i.relname = ?',
            'constraint' => 'SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE '
                . 'c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND k.conname = ?',
            'trigger' => 'SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE '
                . 'c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND g.tgname = ? AND '
                . 'NOT g.tgisinternal',
            'function' => 'SELECT COUNT(*) FROM pg_proc WHERE pronamespace = current_schema()::regnamespace '
                . 'AND proname = ?',
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
    /** @var array<string, array{from: string, to: string, state: string, step: int}> One history row per plan name */
    private array $history = [];
    /** The id of the server session holding the lock (MySQL CONNECTION_ID, PostgreSQL pg_backend_pid). */
    private int $serverSession = 0;

    /**
     * @param PlanList $plans
     * @param PlanClock $now
     * @param PlanEventHandler|null $events
     */
    private function __construct(
        private readonly \PDO $c,
        string $dialect,
        private readonly string $server,
        array $plans,
        private readonly \Closure $now,
        private readonly ?\Closure $events
    ) {
        Dbspec::checkServer($dialect, $server);
        $this->r = new Renderer($dialect);
        if ($c->getAttribute(\PDO::ATTR_ERRMODE) !== \PDO::ERRMODE_EXCEPTION) {
            throw new \InvalidArgumentException('apply needs a connection whose error mode is PDO::ERRMODE_EXCEPTION');
        }
        Graph::plans($plans, 'the plans');
        $chain = PlanChain::chain($plans);
        if ($chain->plans === null) {
            throw new ApplyError('chain', '', 0, $chain->diagnostics[0]->message);
        }
        $this->chain = $chain->plans;
    }

    /**
     * Runs one plan operation of Dbspec: apply, recover, rollback or finalize; another operation is a ValueError.
     *
     * @param string $operation the Dbspec method
     * @param PlanList $plans as for that method
     * @param PlanClock $now as for that method
     * @param PlanEventHandler|null $events as for that method
     */
    public static function operate(
        string $operation,
        \PDO $c,
        string $dialect,
        string $server,
        array $plans,
        \Closure $now,
        ?\Closure $events
    ): void {
        $step = match ($operation) {
            'apply' => self::applyRemaining(...),
            'recover' => self::recoverLastPlan(...),
            'rollback' => self::rollbackLastPlan(...),
            'finalize' => self::finalizeApplied(...),
            default => throw new \ValueError(
                "$operation is not a plan operation; apply, recover, rollback and finalize are"
            ),
        };
        self::inSession($c, $dialect, $server, $plans, $now, $events, $step);
    }

    private static function applyRemaining(self $a): void
    {
        $position = $a->settled();
        foreach (array_slice($a->chain, $position) as $plan) {
            $a->applyPlan($plan);
        }
    }

    private static function recoverLastPlan(self $a): void
    {
        $a->withLastPlan(static function (Plan $plan, array $row) use ($a): void {
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

    private static function rollbackLastPlan(self $a): void
    {
        $a->withLastPlan(static function (Plan $plan, array $row) use ($a): void {
            $steps = $a->steps($plan);
            $k = $row['step'];
            $applied = $row['state'] === self::APPLIED || $row['state'] === self::DONE;
            if ($applied) {
                if ($k < 0 || $k > count($steps)) {
                    throw new ApplyError(
                        'chain',
                        $plan->name,
                        0,
                        sprintf("the recorded step %d is outside the plan's %d steps", $k, count($steps))
                    );
                }
                $a->convert((int) array_search($plan, $a->chain, true) + 1);
                try {
                    $drift = $a->mismatch($plan->to);
                } catch (\RuntimeException $e) {
                    throw new ApplyError('verify', $plan->name, 0, '', $e);
                }
                if ($drift !== '') {
                    throw new ApplyError('drift', $plan->name, 0, $drift);
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
            $a->c->prepare('DELETE FROM ' . $q(self::HISTORY) . ' WHERE ' . $q('name') . ' = ?')
                ->execute([$plan->name]);
            $a->emit(new ApplyEvent('done', $plan->name, 0, count($steps), ''));
        });
    }

    private static function finalizeApplied(self $a): void
    {
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
    }

    /**
     * Runs an operation after validating the plan chain and inside its locked database session.
     *
     * @param list<Plan> $plans
     * @param \Closure(): \DateTimeInterface $now
     * @param ?\Closure(ApplyEvent): void $events
     * @param PlanSessionOperation $operation
     */
    private static function inSession(
        \PDO $c,
        string $dialect,
        string $server,
        array $plans,
        \Closure $now,
        ?\Closure $events,
        \Closure $operation
    ): void {
        $apply = new self($c, $dialect, $server, $plans, $now, $events);
        $apply->session(static function () use ($apply, $operation): void {
            $operation($apply);
        });
    }

    /**
     * The index of the first finalize step.
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
        return new ApplyError(
            'irreversible',
            $plan->name,
            $i,
            $steps[$i]->finalize ? 'a finalize step has no rollback' : $steps[$i]->irreversible
        );
    }

    /**
     * Takes the dialect's lock and changes the session settings, runs $f, and at the end restores the settings
     * and releases the lock. Even if $f fails, all cleanup runs, and an error raised then is thrown
     * together with $f's error from finish.
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
                // A NULL from GET_LOCK is an error raised while waiting for the lock.
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
                        $this->c->exec("SET SESSION lock_wait_timeout = {$previous[0]}, "
                            . "innodb_lock_wait_timeout = {$previous[1]}");
                    }
                }, fn() => $this->c->exec('DO RELEASE_LOCK(' . self::MYSQL_LOCK . ')'));
                return;
            case 'postgres':
                // If current_schema() is NULL, the result is also NULL and an error.
                $this->openSession(self::SESSION_QUERIES['postgres']);
                [$got, $current] = $this->queryRow('SELECT pg_try_advisory_lock(' . self::POSTGRES_LOCK
                    . '), pg_backend_pid()');
                if ($got === false) {
                    throw new ApplyError('locked', '', 0, "another session holds the $h advisory lock of this schema");
                }
                if ($got !== true) {
                    throw new \RuntimeException('pg_try_advisory_lock returned ' . var_export($got, true)
                        . '; want true or false');
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
                        throw new \RuntimeException('pg_advisory_unlock returned ' . var_export($released, true)
                            . '; want true or false');
                    }
                });
                return;
        }
        $this->sqliteSession($f);
    }

    /**
     * Locks the file with SQLite's exclusive locking mode, turns off foreign keys, and lets the rename
     * bring along another table's foreign keys.
     *
     * @param \Closure(): void $f
     */
    private function sqliteSession(\Closure $f): void
    {
        $foreignKeys = CatalogRows::integer([$this->queryValue('PRAGMA foreign_keys')], 0, 'PRAGMA foreign_keys');
        $legacy = CatalogRows::integer(
            [$this->queryValue('PRAGMA legacy_alter_table')],
            0,
            'PRAGMA legacy_alter_table'
        );
        $busy = CatalogRows::integer([$this->queryValue('PRAGMA busy_timeout')], 0, 'PRAGMA busy_timeout');
        $mode = CatalogRows::text([$this->queryValue('PRAGMA locking_mode')], 0, 'PRAGMA locking_mode');
        $this->c->exec('PRAGMA busy_timeout = ' . (self::LOCK_WAIT_SECONDS * 1000));
        // Another connection holds the database, so this connection took no lock for the release read to release.
        $locked = false;
        $this->finish(function () use ($f, &$locked): void {
            $this->c->exec('PRAGMA locking_mode = EXCLUSIVE');
            try {
                $this->c->exec('BEGIN EXCLUSIVE');
            } catch (\PDOException $e) {
                if (!self::sqliteLockResult($e)) {
                    throw $e;
                }
                $locked = true;
                throw new ApplyError('locked', '', 0, 'another connection holds the SQLite database', $e);
            }
            $this->c->exec('COMMIT');
            $this->c->exec('PRAGMA foreign_keys = OFF');
            $this->c->exec('PRAGMA legacy_alter_table = OFF');
            $f();
        }, // The release read must not wait a second time for the lock that another connection holds.
            function () use (&$locked): void {
                if ($locked) {
                    $this->c->exec('PRAGMA busy_timeout = 0');
                }
            },
            fn() => $this->c->exec("PRAGMA foreign_keys = $foreignKeys"),
            fn() => $this->c->exec("PRAGMA legacy_alter_table = $legacy"),
            fn() => $this->c->exec("PRAGMA locking_mode = $mode"),
            // The lock is released only after the locking mode is restored and read once. When another connection
            // holds the database, a lock result of the read means there is no lock to release.
            function () use (&$locked): void {
                try {
                    $this->queryValue('SELECT COUNT(*) FROM sqlite_master');
                } catch (\PDOException $e) {
                    if (!$locked || !self::sqliteLockResult($e)) {
                        throw $e;
                    }
                }
            },
            fn() => $this->c->exec("PRAGMA busy_timeout = $busy"));
    }

    /**
     * Runs $f, then runs end in order regardless of the earlier failure. If there is one error,
     * it is thrown as is; if there are several, the first error and the cleanup errors after it are carried together in
     * an ApplyCleanupError, which is thrown.
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
            // Flattens the inner cleanup errors into one list, keeping their order.
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
     * The first row the query returned. If there is no row, or the result cannot be closed, it is an error.
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
     * The first value of the first row the query returned.
     *
     * @param list<mixed> $args
     */
    private function queryValue(string $query, array $args = []): mixed
    {
        return $this->queryRow($query, $args)[0];
    }

    private static function sqliteLockResult(\PDOException $error): bool
    {
        $info = $error->errorInfo;
        if (!is_array($info) || !isset($info[1]) || !is_int($info[1])) {
            return false;
        }
        $code = $info[1] & 0xff;
        return $code === 5 || $code === 6;
    }

    /** Creates the history table if it does not exist. */
    private function createHistory(): void
    {
        $q = $this->r->q(...);
        [$integer, $text, $tail] = ['integer', 'varchar(71)', ''];
        if ($this->r->dialect === 'mysql') {
            [$integer, $text] = ['INT', 'varchar(71) CHARACTER SET ascii COLLATE ascii_bin'];
            $tail = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';
        }
        $this->c->exec('CREATE TABLE IF NOT EXISTS ' . $q(self::HISTORY) . ' (' .
            $q('name') . " $text NOT NULL, " . $q('from_hash') . " $text NOT NULL, "
                . $q('to_hash') . " $text NOT NULL, " .
            $q('state') . " $text NOT NULL, " . $q('step') . " $integer NOT NULL, "
                . $q('steps') . " $integer NOT NULL, " .
            $q('applied_at') . " $text NOT NULL, PRIMARY KEY (" . $q('name') . '))' . $tail);
    }

    private function readHistory(): void
    {
        $this->createHistory();
        $q = $this->r->q(...);
        $query = 'SELECT ' . $q('name') . ', ' . $q('from_hash') . ', ' . $q('to_hash') . ', ' . $q('state') . ', '
            . $q('step') . ' FROM ' . $q(self::HISTORY);
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
     * Reads the history and returns the number of recorded plans. Records must be at the front of the chain,
     * and the row before the last must be applied or done.
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
                throw new ApplyError(
                    'chain',
                    $plan->name,
                    0,
                    "the recorded plan has other hashes than the chain's plan"
                );
            }
            if ($i !== $position) {
                throw new ApplyError('chain', $plan->name, 0, 'a plan before it in the chain is not recorded');
            }
            if (
                !in_array($row['state'], [self::APPLYING, self::APPLIED, self::FINALIZING, self::DONE,
                self::ROLLING_BACK], true)
            ) {
                throw new ApplyError(
                    'chain',
                    $plan->name,
                    0,
                    "the recorded state {$row['state']} is not a history state"
                );
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

    /** Returns the number of recorded plans when no plan is interrupted and the catalog matches the recorded schema. */
    private function settled(): int
    {
        $position = $this->position();
        $want = '';
        if ($position > 0) {
            $plan = $this->chain[$position - 1];
            $row = $this->history[$plan->name];
            if ($row['state'] !== self::APPLIED && $row['state'] !== self::DONE) {
                throw new ApplyError(
                    'interrupted',
                    $plan->name,
                    $row['step'],
                    "the plan is {$row['state']}; run recover or rollback"
                );
            }
            $want = $plan->to;
        }
        $this->convert($position);
        try {
            $drift = $this->mismatch($want);
        } catch (\RuntimeException $e) {
            throw new ApplyError('verify', '', 0, '', $e);
        }
        if ($drift !== '') {
            throw new ApplyError('drift', '', 0, $drift);
        }
        return $position;
    }

    /**
     * Converts the uuid columns in the text storage of a release up to 0.0.28 to 16 bytes, before the drift check and
     * before any plan (PLN-108). It converts nothing on PostgreSQL, on a database with no recorded plan, and when an
     * unsupported object other than such a column exists or the schema with such columns read as uuid is not the state;
     * the drift check then reports the database.
     */
    private function convert(int $position): void
    {
        if ($this->r->dialect === 'postgres' || $position === 0) {
            return;
        }
        $state = $this->chain[$position - 1];
        try {
            $result = Dbspec::introspect($this->c, $this->r->dialect, $this->server, 'schema');
        } catch (\RuntimeException $e) {
            throw new ApplyError('verify', '', 0, '', $e);
        }
        /** @var array<string, list<string>> $text */
        $text = [];
        foreach ($result->unsupported as $u) {
            if ($u->kind !== 'column' || $u->reason !== Catalog::TEXT_STORAGE_REASON) {
                return;
            }
            $text[$u->table][] = $u->name;
        }
        if ($text === []) {
            return;
        }
        // A dropped foreign key is missing only while its table holds a column in text storage (PLN-109).
        /** @var array<string, list<ForeignKey>> $missing */
        $missing = [];
        foreach ($result->document->tables as $t) {
            $want = self::documentTable($state->schema, $t->name);
            if (!isset($text[$t->name]) || $want === null) {
                continue;
            }
            foreach ($want->foreignKeys as $f) {
                if (!self::hasForeignKey($t->foreignKeys, $f->name)) {
                    $t->foreignKeys[] = $f;
                    $missing[$t->name][] = $f;
                }
            }
        }
        $manifest = Dbspec::manifest([$result->document]);
        if ($manifest->manifest === null || $manifest->manifest->schemaHash !== $state->to) {
            return;
        }
        try {
            $statements = $this->r->dialect === 'mysql'
                ? $this->mysqlConversion($state->schema, $text, $missing)
                : $this->sqliteConversion($state->schema, $text);
        } catch (\PDOException | \RuntimeException $e) {
            throw new ApplyError('convert', '', 0, '', $e);
        }
        $open = false;
        foreach ($statements as $i => $statement) {
            try {
                $this->emit(new ApplyEvent('convert', '', $i, 0, $statement));
            } catch (\Throwable $e) {
                $this->endConversion($open, $e);
            }
            try {
                $this->c->exec($statement);
            } catch (\PDOException $e) {
                $this->endConversion($open, new ApplyError('convert', '', $i, $statement, $e));
            }
            if (str_starts_with($statement, 'SAVEPOINT ')) {
                $open = true;
            } elseif (str_starts_with($statement, 'RELEASE ')) {
                $open = false;
            }
        }
    }

    /**
     * Throws $e after a stop or a failure of the conversion; inside the SQLite rebuild of a table it rolls the table
     * back first, so that the table is kept as it was (PLN-110).
     */
    private function endConversion(bool $open, \Throwable $e): never
    {
        if (!$open) {
            throw $e;
        }
        $cleanup = [];
        foreach (['ROLLBACK TO ', 'RELEASE '] as $verb) {
            try {
                $this->c->exec($verb . self::CONVERT_SAVEPOINT);
            } catch (\Throwable $error) {
                $cleanup[] = $error;
            }
        }
        throw $cleanup === [] ? $e : new ApplyCleanupError($e, $cleanup);
    }

    private static function documentTable(Document $d, string $name): ?Table
    {
        foreach ($d->tables as $t) {
            if ($t->name === $name) {
                return $t;
            }
        }
        return null;
    }

    private static function stateTable(Document $state, string $name): Table
    {
        return self::documentTable($state, $name) ?? throw new \LogicException("the state has no table $name");
    }

    /** @param list<ForeignKey> $keys */
    private static function hasForeignKey(array $keys, string $name): bool
    {
        foreach ($keys as $f) {
            if ($f->name === $name) {
                return true;
            }
        }
        return false;
    }

    private static function stateColumn(Document $state, string $table, string $name): Column
    {
        foreach (self::stateTable($state, $table)->columns as $c) {
            if ($c->name === $name) {
                return $c;
            }
        }
        throw new \LogicException("the state has no column $table.$name");
    }

    /**
     * The columns of table $t among $names, in the order of the state table.
     *
     * @param list<string> $names
     * @return list<string>
     */
    private static function stateColumnOrder(Document $state, string $t, array $names): array
    {
        $out = [];
        foreach (self::stateTable($state, $t)->columns as $c) {
            if (in_array($c->name, $names, true)) {
                $out[] = $c->name;
            }
        }
        return $out;
    }

    /**
     * $items sorted by their name in byte order, keeping the order of equal names.
     *
     * @template T of Table|ForeignKey
     * @param list<T> $items
     * @return list<T>
     */
    private static function sortedByName(array $items): array
    {
        usort($items, static fn(Table|ForeignKey $a, Table|ForeignKey $b): int => strcmp($a->name, $b->name));
        return $items;
    }

    /**
     * The statements of PLN-109 on MySQL and MariaDB, from the storage that the database has now: a command that
     * stopped between two statements writes the statements that remain.
     *
     * @param array<string, list<string>> $text
     * @param array<string, list<ForeignKey>> $missing
     * @return list<string>
     */
    private function mysqlConversion(Document $state, array $text, array $missing): array
    {
        $q = $this->r->q(...);
        $tables = array_map('strval', array_keys($text));
        sort($tables, SORT_STRING);
        $textColumn = static fn(string $table, string $column): bool => in_array($column, $text[$table] ?? [], true);
        // The column types of the columns in text storage: char(36), or varbinary(36) of a conversion that stopped.
        $types = [];
        foreach ($tables as $t) {
            foreach ($text[$t] as $c) {
                $types[$t][$c] = (string) $this->queryValue(
                    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND '
                        . 'TABLE_NAME = ? AND COLUMN_NAME = ?',
                    [$t, $c]
                );
            }
        }
        $out = [];
        // 1. The foreign keys of the state that the database has and whose columns or referenced columns are in text
        // storage.
        $dropped = [];
        foreach (self::sortedByName($state->tables) as $st) {
            foreach (self::sortedByName($st->foreignKeys) as $f) {
                if (self::hasForeignKey($missing[$st->name] ?? [], $f->name)) {
                    continue;
                }
                $uses = false;
                foreach ($f->columns as $c) {
                    $uses = $uses || $textColumn($st->name, $c);
                }
                foreach ($f->referencedColumns as $c) {
                    $uses = $uses || $textColumn($f->table, $c);
                }
                if ($uses) {
                    $out[] = 'ALTER TABLE ' . $q($st->name) . ' DROP FOREIGN KEY ' . $q($f->name);
                    $dropped[$st->name][] = $f;
                }
            }
        }
        foreach ($missing as $t => $fs) {
            $dropped[$t] = array_merge($dropped[$t] ?? [], $fs);
        }
        $textDefinition = static function (Column $c) use ($q): string {
            $s = $q($c->name) . ' VARBINARY(36)' . ($c->nullable ? ' NULL' : ' NOT NULL');
            if ($c->default !== null) {
                $s .= ' DEFAULT ' . $c->default;
            }
            return $s;
        };
        // 2. Each char(36) column becomes varbinary(36), which holds both forms.
        foreach ($tables as $t) {
            foreach (self::stateColumnOrder($state, $t, $text[$t]) as $c) {
                if ($types[$t][$c] !== 'char(36)') {
                    continue;
                }
                $check = $q(Names::render($t, $c));
                $out[] = 'ALTER TABLE ' . $q($t) . " DROP CONSTRAINT $check, MODIFY COLUMN "
                    . $textDefinition(self::stateColumn($state, $t, $c))
                    . ", ADD CONSTRAINT $check CHECK (length(" . $q($c) . ') IN (16, 36))';
            }
        }
        // 3. The texts become their 16 bytes.
        foreach ($tables as $t) {
            foreach (self::stateColumnOrder($state, $t, $text[$t]) as $c) {
                $query = 'SELECT COUNT(*) FROM (SELECT 1 FROM ' . $q($t) . ' WHERE length(' . $q($c)
                    . ') = 36 LIMIT 1) x';
                if (CatalogRows::integer([$this->queryValue($query)], 0, $query) > 0) {
                    $out[] = 'UPDATE ' . $q($t) . ' SET ' . $q($c) . ' = UNHEX(REPLACE(' . $q($c) . ", '-', '')) WHERE "
                        . 'length(' . $q($c) . ') = 36';
                }
            }
        }
        // 4. Each table gets its rendered form, a referenced table before the tables that reference it, with its
        // dropped foreign keys whose referenced table has its rendered form.
        $pending = array_fill_keys($tables, true);
        $added = [];
        while ($pending !== []) {
            $next = null;
            $first = null;
            foreach ($tables as $t) {
                if (!isset($pending[$t])) {
                    continue;
                }
                $ready = true;
                foreach (self::stateTable($state, $t)->foreignKeys as $f) {
                    if ($f->table !== $t && isset($pending[$f->table])) {
                        $ready = false;
                    }
                }
                if ($ready) {
                    $next = $t;
                    break;
                }
                $first ??= $t;
            }
            // A cycle of such tables takes the first of them by name; its foreign keys to a pending table are added
            // last.
            $next ??= (string) $first;
            unset($pending[$next]);
            $parts = [];
            foreach (self::stateColumnOrder($state, $next, $text[$next]) as $c) {
                $check = $q(Names::render($next, $c));
                $col = self::stateColumn($state, $next, $c);
                array_push(
                    $parts,
                    "DROP CONSTRAINT $check",
                    'MODIFY COLUMN ' . $this->r->column($col),
                    "ADD CONSTRAINT $check CHECK (" . $this->r->typeCheck($col) . ')'
                );
            }
            foreach (self::sortedByName($dropped[$next] ?? []) as $f) {
                if (!isset($pending[$f->table])) {
                    $parts[] = 'ADD ' . $this->r->foreignKey($f);
                    $added[$next . '.' . $f->name] = true;
                }
            }
            $out[] = 'ALTER TABLE ' . $q($next) . ' ' . implode(', ', $parts);
        }
        // 5. A foreign key of a cycle, and one of a table without text storage, is added last.
        $owners = array_map('strval', array_keys($dropped));
        sort($owners, SORT_STRING);
        foreach ($owners as $t) {
            foreach (self::sortedByName($dropped[$t]) as $f) {
                if (!isset($added[$t . '.' . $f->name])) {
                    $out[] = 'ALTER TABLE ' . $q($t) . ' ADD ' . $this->r->foreignKey($f);
                }
            }
        }
        return $out;
    }

    /**
     * The statements of PLN-110: each table that holds a column in text storage, in name order, is rebuilt in its
     * rendered form inside one savepoint.
     *
     * @param array<string, list<string>> $text
     * @return list<string>
     */
    private function sqliteConversion(Document $state, array $text): array
    {
        $q = $this->r->q(...);
        $tables = array_map('strval', array_keys($text));
        sort($tables, SORT_STRING);
        $rebuild = PlanSteps::REBUILD_TABLE;
        $out = [];
        foreach ($tables as $name) {
            $t = self::stateTable($state, $name);
            $out[] = 'SAVEPOINT ' . self::CONVERT_SAVEPOINT;
            $out[] = $this->r->createTable(
                $t,
                $rebuild,
                static fn(string $c): string => Names::render($t->name, $c),
                []
            );
            $identity = false;
            foreach ($t->columns as $c) {
                $identity = $identity || $c->identity;
            }
            if ($identity) {
                $out[] = "INSERT INTO sqlite_sequence (name, seq) SELECT '$rebuild', seq FROM sqlite_sequence "
                    . "WHERE name = '$name'";
            }
            $into = [];
            $from = [];
            foreach ($t->columns as $c) {
                $into[] = $q($c->name);
                $from[] = in_array($c->name, $text[$name], true)
                    ? 'unhex(replace(' . $q($c->name) . ", '-', ''))"
                    : $q($c->name);
            }
            $out[] = 'INSERT INTO ' . $q($rebuild) . ' (' . implode(', ', $into) . ') SELECT ' . implode(', ', $from)
                . ' FROM ' . $q($name);
            $out[] = 'DROP TABLE ' . $q($name);
            $out[] = 'ALTER TABLE ' . $q($rebuild) . ' RENAME TO ' . $q($name);
            array_push($out, ...array_slice($this->r->table($t), 1));
            array_push($out, ...$this->r->triggers($t));
            $out[] = 'RELEASE ' . self::CONVERT_SAVEPOINT;
        }
        return $out;
    }

    /** @param \Closure(Plan, array{from: string, to: string, state: string, step: int}): void $operation */
    private function withLastPlan(\Closure $operation): void
    {
        $position = $this->position();
        if ($position === 0) {
            return;
        }
        $plan = $this->chain[$position - 1];
        $operation($plan, $this->history[$plan->name]);
    }

    /**
     * Checks that the database's introspection is want schemaHash (if '', an empty database) and that there
     * are no unsupported objects.
     */
    private function verify(string $want): void
    {
        $drift = $this->mismatch($want);
        if ($drift !== '') {
            throw new PlanSchemaMismatch($drift);
        }
    }

    /**
     * How the database's introspection differs from want schemaHash (if '', an empty database), or '' when it
     * is want and holds no unsupported objects.
     */
    private function mismatch(string $want): string
    {
        $result = Dbspec::introspect($this->c, $this->r->dialect, $this->server, 'schema');
        if ($result->unsupported !== []) {
            $u = $result->unsupported[0];
            return sprintf(
                'the database has %d objects that dbspec cannot express, first %s %s %s: %s',
                count($result->unsupported),
                $u->kind,
                $u->table,
                $u->name,
                $u->reason
            );
        }
        $got = '';
        if ($result->document->tables !== []) {
            $manifest = Dbspec::manifest([$result->document]);
            if ($manifest->manifest === null) {
                return 'the introspected schema is invalid: ' . json_encode(array_map(
                    static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message],
                    $manifest->diagnostics
                ));
            }
            $got = $manifest->manifest->schemaHash;
        }
        if ($got !== $want) {
            return sprintf(
                'the database is at %s, not %s',
                $got === '' ? 'empty' : $got,
                $want === '' ? 'empty' : $want
            );
        }
        return '';
    }

    /**
     * The step that uses the previous plan's target in the chain as the source of the plan.
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
     * Decides the step of an interrupted row by the catalog's effect: going forward if forward, otherwise going
     * backward,
     * is where to resume (docs/spec/plans.md "Apply"'s recover).
     *
     * @param array{from: string, to: string, state: string, step: int} $row
     * @param list<PlanStep> $steps
     */
    private function resolve(Plan $plan, array $row, array $steps, bool $forward): int
    {
        $k = $row['step'];
        if ($k < 0 || $k > count($steps)) {
            throw new ApplyError(
                'chain',
                $plan->name,
                0,
                sprintf("the recorded step %d is outside the plan's %d steps", $k, count($steps))
            );
        }
        $rolling = $row['state'] === self::ROLLING_BACK;
        $uncertain = $rolling ? $k - 1 : $k;
        if ($uncertain < 0 || $uncertain >= count($steps)) {
            return $k;
        }
        $e = $steps[$uncertain]->effect;
        $held = $e->kind !== 'repeat' && $this->effect($plan, $uncertain, $e);
        // When going forward, a repeat step is run again; when going backward, its rollback is run again.
        $took = $held || (!$forward && $e->kind === 'repeat');
        if ($rolling) {
            return $took ? $k : $k - 1;
        }
        return $took ? $k + 1 : $k;
    }

    /** Writes the plan's row by state and step. If there is no row, creates it. */
    private function record(Plan $plan, string $state, int $step): void
    {
        $q = $this->r->q(...);
        if (!isset($this->history[$plan->name])) {
            $steps = count($this->steps($plan));
            // applied_at is the UTC time of the tool clock, truncated to six fractional digits as text
            // (docs/spec/plans.md "Apply").
            $appliedAt = \DateTimeImmutable::createFromInterface(($this->now)())
                ->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.u\Z');
            $this->c->prepare('INSERT INTO ' . $q(self::HISTORY) . ' (' . $q('name') . ', ' . $q('from_hash') . ', '
                . $q('to_hash') . ', ' . $q('state') . ', ' . $q('step') . ', ' . $q('steps') . ', '
                . $q('applied_at') . ') VALUES (?, ?, ?, ?, ?, ?, ?)')
                ->execute([$plan->name, $plan->from ?? 'empty', $plan->to, $state, $step, $steps, $appliedAt]);
            $this->history[$plan->name] = ['from' => $plan->from ?? 'empty', 'to' => $plan->to,
            'state' => $state, 'step' => $step];
            return;
        }
        $this->c->prepare('UPDATE ' . $q(self::HISTORY) . ' SET ' . $q('state') . ' = ?, ' . $q('step') . ' = ? WHERE '
            . $q('name') . ' = ?')
            ->execute([$state, $step, $plan->name]);
    }

    private function setStep(Plan $plan, int $step): void
    {
        $q = $this->r->q(...);
        $this->c->prepare('UPDATE ' . $q(self::HISTORY) . ' SET ' . $q('step') . ' = ? WHERE ' . $q('name') . ' = ?')
            ->execute([$step, $plan->name]);
    }

    /** Applies one plan up to its finalize step, and verifies it. */
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
     * Runs from the start step up to the finalize step, verifies, and then changes the row to applied.
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
     * Runs the finalize step from start, and changes the row to done.
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
     * Before taking the lock, remembers the server session's id. If that session already holds the lock, another
     * client is using the same server session, so it is a session error.
     */
    private function openSession(string $query): void
    {
        $row = $this->queryRow($query);
        $this->serverSession = CatalogRows::integer($row, 0, $query);
        if ($row[1] === true || $row[1] === 1 || $row[1] === '1') {
            throw new ApplyError('session', '', 0, 'this server session already holds the ' . self::HISTORY
                . ' lock, so another client shares it; ' . self::SESSION_REQUIREMENT);
        }
    }

    /**
     * Checks that current is the server session holding the lock. If not, it is a session error before step i
     * of the plan (or at the lock if the plan is null).
     */
    private function sameSession(?Plan $plan, int $i, mixed $current): void
    {
        $id = CatalogRows::integer([$current], 0, 'server session id');
        if ($id === $this->serverSession) {
            return;
        }
        throw new ApplyError(
            'session',
            $plan?->name ?? '',
            $plan === null ? 0 : $i,
            "the connection moved from server session {$this->serverSession} to $id; " . self::SESSION_REQUIREMENT
        );
    }

    /**
     * Runs one statement of step i together with its event. Before the statement, checks the server session
     * (for SQLite, the connection is a single file).
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

    /** Checks whether SQLite has any row that violates a foreign key. */
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
     * Fills the NULL rows of a column that the rollback of an applied plan would restore to non-null with the default,
     * or stops with a nulls error if there is no default (docs/spec/plans.md "Steps").
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
                    throw new ApplyError(
                        'nulls',
                        $plan->name,
                        $i,
                        sprintf(
                            'column %s.%s has %d NULL rows and no default to restore NOT NULL',
                            $check->table,
                            $check->column,
                            $n
                        )
                    );
                }
                $this->c->exec('UPDATE ' . $q($check->table) . ' SET ' . $q($check->column) . ' = ' . $check->default
                    . ' WHERE ' . $q($check->column) . ' IS NULL');
            }
        }
    }

    private function emit(ApplyEvent $event): void
    {
        if ($this->events !== null) {
            ($this->events)($event);
        }
    }

    /** Tells whether the effect is in the database now. If it cannot be read, it is the step's failed error. */
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

    private function effectHolds(Effect $e): bool
    {
        if ($e->kind === 'rows') {
            $query = 'SELECT COUNT(*) FROM (SELECT 1 FROM ' . $this->r->q($e->table) . ' LIMIT 1) x';
            $args = [];
        } else {
            $query = self::EFFECT_QUERIES[$this->r->dialect][$e->kind] ?? throw new \RuntimeException(
                "the effect {$e->text()} has no query on {$this->r->dialect}"
            );
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
     * An entry point for tests that reads one effect (DbspecApplyCleanupTest.php).
     *
     * @internal
     */
    public static function effectOn(\PDO $c, string $dialect, Effect $e): bool
    {
        return (new self($c, $dialect, $dialect, [], static fn() => new \DateTimeImmutable(), null))->effectHolds($e);
    }
}
