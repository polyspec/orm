<?php
declare(strict_types=1);

namespace Orm;

/**
 * A database connection: the PDO handle, its engine, the statement cache,
 * and the transactions of the request.
 */
final class Db
{
    public const DRIVERS = ['mysql', 'postgres', 'sqlite'];
    public const SECRET = '$SECRET';
    public const NOW = '$NOW';

    /** @var list<TxFrame> active transactions of the request, innermost last */
    private static array $frames = [];

    /** @var array<string, \PDOStatement> */
    private array $stmts = [];
    /** @var list<string> */
    private array $stmtOrder = [];
    private bool $closed = false;
    /** @var array<int, string> masked bind positions of the last args() result */
    private array $masks = [];
    private bool $typed = false;

    /** @internal Orm::connect creates connections. */
    public function __construct(
        private readonly \PDO $pdo,
        private readonly string $driver,
        private readonly Config $config,
        private readonly Engine $engine,
        private readonly \DateTimeZone $zone,
    ) {
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        // MySQL uses emulated prepares: a request runs most statement shapes once.
        $pdo->setAttribute(\PDO::ATTR_EMULATE_PREPARES, $driver === 'mysql');
        $pdo->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, false);
    }

    /**
     * The configured maximum of connections a process opens for this
     * database. PDO has no pool: a Db holds one connection, so the value is
     * the bound a caller keeps when it creates connections.
     */
    public function poolSize(): int
    {
        return $this->config->poolSize;
    }

    /** The database of the connection: mysql, postgres, or sqlite. */
    public function driver(): string
    {
        return $this->driver;
    }

    /** @internal the connection time zone */
    public function zone(): \DateTimeZone
    {
        return $this->zone;
    }

    /** @internal */
    public function config(): Config
    {
        return $this->config;
    }

    /** @internal */
    public function pdo(): \PDO
    {
        if ($this->closed) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        return $this->pdo;
    }

    /** The operations outside the query syntax. */
    public function utils(): Utils
    {
        return new Utils($this);
    }

    /** Releases cached statements; the connection cannot be used afterwards. */
    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        foreach ($this->stmts as $st) {
            $st->closeCursor();
        }
        $this->stmts = [];
        $this->stmtOrder = [];
    }

    public static function bindLimit(string $driver): int
    {
        return $driver === 'sqlite' ? 999 : 65535;
    }

    private function stmt(string $sql): \PDOStatement
    {
        if ($this->closed) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        if (isset($this->stmts[$sql])) {
            return $this->stmts[$sql];
        }
        // pdo_pgsql numbers placeholders itself; the plan's $n are in slot order.
        $st = $this->pdo->prepare($this->driver === 'postgres' ? preg_replace('/\$\d+/', '?', $sql) : $sql);
        $this->stmts[$sql] = $st;
        $this->stmtOrder[] = $sql;
        while (count($this->stmtOrder) > $this->config->statementCacheSize) {
            $oldest = array_shift($this->stmtOrder);
            $this->stmts[$oldest]->closeCursor();
            unset($this->stmts[$oldest]);
        }
        return $st;
    }

    // ---- transactions ----

    /** @internal the innermost active transaction of the connection */
    public static function activeFor(Db $db): ?TxFrame
    {
        for ($i = count(self::$frames) - 1; $i >= 0; $i--) {
            if (self::$frames[$i]->db === $db) {
                return self::$frames[$i];
            }
        }
        return null;
    }

    /**
     * @internal where a model runs: the active transaction of its connection,
     * the connection, or the innermost transaction for a model without one.
     * @return array{0: Db, 1: ?TxFrame}
     */
    public static function resolve(?Db $conn): array
    {
        if ($conn !== null) {
            if ($conn->closed) {
                throw new OrmException(Code::CONFIG, 'database is closed');
            }
            return [$conn, self::activeFor($conn)];
        }
        $frame = self::$frames[count(self::$frames) - 1] ?? null;
        if ($frame === null) {
            throw new OrmException(Code::CONFIG, 'the model has no connection; use connect or run it inside a transaction');
        }
        return [$frame->db, $frame];
    }

    /** @internal runs $fn in a transaction of $conn, or directly inside the active one */
    public static function inTransaction(?Db $conn, \Closure $fn): void
    {
        if ($conn === null) {
            if (self::$frames === []) {
                throw new OrmException(Code::CONFIG, 'the model has no connection; use connect or run it inside a transaction');
            }
            $fn();
            return;
        }
        $conn->transaction($fn, retry: 0);
    }

    /**
     * Runs $fn in one transaction and returns its result. An exception rolls
     * back; models without connect inside $fn use this transaction. A
     * transaction of the same connection inside an active one creates a
     * savepoint and accepts only retry, which it ignores.
     */
    public function transaction(\Closure $fn, string $isolation = '', bool $readOnly = false, int $timeoutMs = 0, int $retry = 3): mixed
    {
        if ($retry < 0) {
            throw new OrmException(Code::CONFIG, 'transaction retry must not be negative');
        }
        if ($timeoutMs < 0) {
            throw new OrmException(Code::CONFIG, 'transaction timeoutMs must not be negative');
        }
        if (!in_array($isolation, ['', 'read_uncommitted', 'read_committed', 'repeatable_read', 'serializable'], true)) {
            throw new OrmException(Code::CONFIG, "unsupported transaction isolation $isolation");
        }
        $outer = self::activeFor($this);
        if ($outer !== null) {
            if ($isolation !== '' || $readOnly || $timeoutMs !== 0) {
                throw new OrmException(Code::CONFIG, 'a nested transaction of the same connection accepts only the retry option');
            }
            return $this->savepoint($outer, $fn);
        }
        for ($attempt = 0; ; $attempt++) {
            try {
                return $this->runTransaction($fn, $isolation, $readOnly, $timeoutMs);
            } catch (OrmException $e) {
                if ($e->code_ !== Code::DEADLOCK || $attempt >= $retry) {
                    throw $e;
                }
                usleep((50000 << $attempt) + random_int(0, 20000));
            }
        }
    }

    private function runTransaction(\Closure $fn, string $isolation, bool $readOnly, int $timeoutMs): mixed
    {
        $frame = $this->begin($isolation, $readOnly, $timeoutMs);
        self::$frames[] = $frame;
        try {
            $v = $fn();
        } catch (\Throwable $e) {
            array_pop(self::$frames);
            $this->finish($frame, false);
            throw $e instanceof \PDOException ? OrmException::fromDriver($e, $this->driver) : $e;
        }
        array_pop(self::$frames);
        $this->finish($frame, true);
        return $v;
    }

    private function begin(string $isolation, bool $readOnly, int $timeoutMs): TxFrame
    {
        if ($this->closed) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        if ($timeoutMs > 0 && $this->driver !== 'postgres') {
            throw new OrmException(Code::CAPABILITY_UNSUPPORTED, 'transaction timeoutMs is supported only by postgres');
        }
        $level = strtoupper(str_replace('_', ' ', $isolation));
        try {
            if ($this->driver === 'mysql') {
                if ($isolation !== '') {
                    $this->pdo->exec('SET TRANSACTION ISOLATION LEVEL ' . $level);
                }
                if ($readOnly) {
                    $this->pdo->exec('SET TRANSACTION READ ONLY');
                }
            }
            if ($this->driver === 'sqlite') {
                $this->pdo->exec('CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))');
            }
            $this->pdo->beginTransaction();
            $frame = new TxFrame($this, $readOnly, $isolation);
            if ($this->driver === 'postgres') {
                if ($isolation !== '') {
                    $this->pdo->exec('SET TRANSACTION ISOLATION LEVEL ' . $level);
                }
                if ($readOnly) {
                    $this->pdo->exec('SET TRANSACTION READ ONLY');
                }
                if ($timeoutMs > 0) {
                    $this->pdo->exec('SET LOCAL statement_timeout = ' . $timeoutMs);
                }
            }
            if ($this->driver === 'sqlite') {
                if ($isolation === 'read_uncommitted') {
                    $this->pdo->exec('PRAGMA read_uncommitted = 1');
                }
                if ($readOnly) {
                    $this->pdo->exec('PRAGMA query_only = 1');
                }
            }
            return $frame;
        } catch (\PDOException $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw OrmException::fromDriver($e, $this->driver);
        }
    }

    private function finish(TxFrame $frame, bool $commit): void
    {
        $frame->finished = true;
        try {
            foreach ($frame->locks as $key) {
                $this->pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([$key]);
            }
            if ($this->driver === 'mysql') {
                foreach ($frame->locals as $key => $_) {
                    $this->pdo->exec('SET @`orm.' . $key . '` = NULL');
                }
            }
            if ($commit && $frame->contextRow) {
                $this->pdo->exec('DELETE FROM "orm__context"');
            }
            if ($this->driver === 'sqlite') {
                if ($frame->readOnly) {
                    $this->pdo->exec('PRAGMA query_only = 0');
                }
                if ($frame->isolation === 'read_uncommitted') {
                    $this->pdo->exec('PRAGMA read_uncommitted = 0');
                }
            }
            $commit ? $this->pdo->commit() : $this->pdo->rollBack();
        } catch (\PDOException $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw OrmException::fromDriver($e, $this->driver);
        }
    }

    private function savepoint(TxFrame $frame, \Closure $fn): mixed
    {
        $name = 'orm_sp_' . (++$frame->savepoints);
        try {
            $this->pdo->exec("SAVEPOINT $name");
            self::$frames[] = $frame;
            try {
                $v = $fn();
            } catch (\Throwable $e) {
                array_pop(self::$frames);
                $this->pdo->exec("ROLLBACK TO SAVEPOINT $name");
                $this->pdo->exec("RELEASE SAVEPOINT $name");
                throw $e instanceof \PDOException ? OrmException::fromDriver($e, $this->driver) : $e;
            }
            array_pop(self::$frames);
            $this->pdo->exec("RELEASE SAVEPOINT $name");
            return $v;
        } catch (\PDOException $e) {
            throw OrmException::fromDriver($e, $this->driver);
        } finally {
            $frame->savepoints--;
        }
    }

    // ---- execution ----

    private function enter(?TxFrame $frame, array $ir): void
    {
        if ($this->closed) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        if ($frame !== null && $frame->finished) {
            throw new OrmException(Code::CONFIG, 'transaction already finished');
        }
        if (($ir['lock'] ?? '') !== '' && $frame === null) {
            throw new OrmException(Code::CONFIG, 'row locks are allowed only inside a transaction');
        }
    }

    private function plan(Request $r): array
    {
        return $this->engine->plan($r->shape());
    }

    /** @internal @return array{0: array, 1: array} the plan and its positional result */
    public function select(?TxFrame $frame, Request $r): array
    {
        $this->enter($frame, $r->ir);
        $plan = $this->plan($r);
        $this->acquireSQLiteRowLock((string) ($r->ir['lock'] ?? ''));
        $parts = $this->rootInParts($r, $plan['steps'][0]);
        if ($parts !== []) {
            $main = [];
            $seen = [];
            foreach ($parts as $part) {
                $partPlan = $this->plan($part);
                foreach ($this->query($partPlan['steps'][0], $part->params) as $row) {
                    $key = self::rowKey($row, $partPlan['steps'][0]['assemble']['key']);
                    if (!isset($seen[$key])) {
                        $seen[$key] = true;
                        $main[] = $row;
                    }
                }
            }
        } else {
            $main = $this->query($plan['steps'][0], $r->params);
        }
        return [$plan, $this->relations($plan, $r->params, $main)];
    }

    /** @internal */
    public function scalarOf(?TxFrame $frame, Request $r): mixed
    {
        $this->enter($frame, $r->ir);
        $plan = $this->plan($r);
        $parts = $this->rootInParts($r, $plan['steps'][0]);
        if ($parts !== []) {
            if ($r->ir['kind'] !== 'count') {
                throw new OrmException(Code::IR_INVALID, 'a split IN list can be merged only for a count');
            }
            $total = 0;
            foreach ($parts as $part) {
                $total += (int) $this->scalar($this->plan($part)['steps'][0], $part->params);
            }
            return $total;
        }
        return $this->scalar($plan['steps'][0], $r->params);
    }

    /** @internal @return array{0: array, 1: array, 2: int} */
    public function paginate(?TxFrame $frame, Request $r): array
    {
        $this->enter($frame, $r->ir);
        $plan = $this->plan($r);
        $main = $this->query($plan['steps'][0], $r->params);
        $result = $this->relations($plan, $r->params, $main);
        foreach ($plan['steps'] as $st) {
            if (($st['role'] ?? '') === 'count') {
                return [$plan, $result, (int) $this->scalar($st, $r->params)];
            }
        }
        throw new OrmException(Code::INTERNAL, 'paginate plan has no count step');
    }

    /** @internal @return array{0: int|string|null, 1: int} the generated id and the affected rows */
    public function writeOf(?TxFrame $frame, Request $r): array
    {
        $this->enter($frame, $r->ir);
        $step = $this->plan($r)['steps'][0];
        $args = $this->args($step, $r->params);
        $insert = $r->ir['kind'] === 'insert';
        $start = microtime(true);
        $st = null;
        try {
            $st = $this->stmt($step['sql']);
            $this->exec($st, $args);
            if ($insert && str_contains($step['sql'], ' RETURNING ')) {
                $id = $st->fetchColumn();
                $st->closeCursor();
                $affected = 1;
            } else {
                $affected = $st->rowCount();
                $id = $insert && !isset($r->ir['rows']) ? $this->pdo->lastInsertId() : null;
            }
        } catch (\PDOException $e) {
            $e = $this->failed($st, $e);
            $this->emit($step['sql'], $args, $start, $step['plan_id'], $e);
            throw $e;
        }
        $this->emit($step['sql'], $args, $start, $step['plan_id'], null);
        if (isset($r->ir['optimistic']) && $affected === 0) {
            throw new OrmException(Code::OPTIMISTIC_LOCK, 'the row changed after it was read');
        }
        return [$id, $affected];
    }

    /** @internal @return array{sql: string, binds: list<mixed>} */
    public function statement(Request $r): array
    {
        $step = $this->plan($r)['steps'][0];
        $args = $this->args($step, $r->params);
        foreach ($this->masks as $i => $mask) {
            $args[$i] = $mask;
        }
        foreach ($args as $i => $v) {
            if ($v instanceof Bytes) {
                $args[$i] = $v->bytes;
            }
        }
        return ['sql' => $step['sql'], 'binds' => $args];
    }

    /**
     * The executor clock in the connection time zone. PostgreSQL receives the
     * offset because its columns store instants.
     */
    private function now(): string
    {
        return (new \DateTimeImmutable('now', $this->zone))->format($this->driver === 'postgres' ? 'Y-m-d H:i:s.uP' : 'Y-m-d H:i:s.u');
    }

    /**
     * Writes a datetime or date value in the text form SQLite stores, so a
     * string value compares equal to the stored value. A datetime string with
     * an offset is converted to the connection time zone.
     */
    private function sqliteTimeValue(mixed $v, string $colType): mixed
    {
        if ($v instanceof \DateTimeInterface) {
            return $colType === 'date'
                ? \DateTimeImmutable::createFromInterface($v)->setTimezone($this->zone)->format('Y-m-d')
                : $v;
        }
        if (!is_string($v)) {
            return $v;
        }
        if ($colType === 'date') {
            $d = preg_match('/^\d{4}-\d{2}-\d{2}$/D', $v) === 1 ? \DateTimeImmutable::createFromFormat('!Y-m-d', $v) : false;
            if ($d === false || $d->format('Y-m-d') !== $v) {
                throw self::invalidTimeText($v, $colType);
            }
            return $v;
        }
        if (preg_match('/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/D', $v, $m) !== 1) {
            throw self::invalidTimeText($v, $colType);
        }
        $fraction = $m[3] ?? '';
        $text = $m[1] . ' ' . $m[2] . '.' . str_pad($fraction, 6, '0');
        $zone = $m[4] ?? '';
        if ($zone === '') {
            $t = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $text);
            if ($t === false || $t->format('Y-m-d H:i:s.u') !== $text) {
                throw self::invalidTimeText($v, $colType);
            }
            return $text;
        }
        $t = \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.uP', $text . ($zone === 'Z' ? '+00:00' : $zone));
        if ($t === false || $t->format('Y-m-d H:i:s.u') !== $text) {
            throw self::invalidTimeText($v, $colType);
        }
        return $t->setTimezone($this->zone)->format('Y-m-d H:i:s.u');
    }

    private static function invalidTimeText(string $v, string $colType): OrmException
    {
        $form = $colType === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:MM:SS[.ffffff][Z|±HH:MM]';
        return new OrmException(Code::CODEC_ENCODE, "$colType value \"$v\" is not $form");
    }

    private function args(array $step, array $params, array $parentVals = []): array
    {
        $out = [];
        $this->masks = [];
        $this->typed = $this->driver === 'sqlite';
        $cfg = $this->config;
        // One statement reads the clock once, so its clock columns are equal.
        $clock = null;
        foreach ($step['bind_slots'] ?? [] as $b) {
            switch ($b['from']) {
                case 'parent':
                    foreach ($parentVals as $v) {
                        $out[] = $v;
                    }
                    break;
                case 'param':
                    $v = $params[$b['param']];
                    $colType = $b['col_type'] ?? '';
                    if ($this->driver === 'sqlite' && ($colType === 'datetime' || $colType === 'date') && $v !== null) {
                        $v = $this->sqliteTimeValue($v, $colType);
                    }
                    if ($v instanceof \DateTimeInterface) {
                        $v = \DateTimeImmutable::createFromInterface($v)->setTimezone($this->zone)->format('Y-m-d H:i:s.u');
                    }
                    if (($b['transform'] ?? '') !== '') {
                        $v = Transform::apply($b['transform'], (string) $v);
                    } elseif (in_array('blind_index', $b['host_styles'] ?? [], true)) {
                        $v = Codec::blindIndex($v, $cfg->blindIndexKey);
                    } elseif (!empty($b['host_styles'])) {
                        $v = Codec::hostEncode($v, $b['host_styles'], $cfg->aesKey);
                        $this->typed = $this->typed || $v instanceof Bytes;
                    } elseif (is_bool($v) || $v instanceof Bytes) {
                        $this->typed = true;
                    }
                    if ($colType === 'point' && $v !== null) {
                        $v = $this->driver === 'postgres' ? Codec::postgresPointText($v) : Codec::pointText($v);
                    }
                    $out[] = $v;
                    break;
                case 'secret':
                    if (($b['name'] ?? '') !== 'aes' || $cfg->aesKey === '') {
                        throw new OrmException(Code::CONFIG, "secret {$b['name']} is not configured");
                    }
                    $this->masks[count($out)] = self::SECRET;
                    $out[] = $cfg->aesKey;
                    break;
                case 'config':
                    if (($b['name'] ?? '') !== 'aes_version') {
                        throw new OrmException(Code::CONFIG, "config value {$b['name']} is not configured");
                    }
                    $out[] = $cfg->aesVersion;
                    break;
                case 'now':
                    $this->masks[count($out)] = self::NOW;
                    $out[] = $clock ??= $this->now();
                    break;
                default:
                    throw new OrmException(Code::INTERNAL, "bind from {$b['from']}");
            }
        }
        return $out;
    }

    /**
     * Binds with types where the driver needs them: MySQL bools as 0/1,
     * PostgreSQL bools and binary values, SQLite ints, bools, blobs, and nulls.
     */
    private function exec(\PDOStatement $st, array $args): void
    {
        if (!$this->typed) {
            $st->execute($args);
            return;
        }
        if ($this->driver === 'mysql') {
            foreach ($args as $i => $v) {
                if (is_bool($v)) {
                    $args[$i] = (int) $v;
                } elseif ($v instanceof Bytes) {
                    $args[$i] = $v->bytes;
                }
            }
            $st->execute($args);
            return;
        }
        $pg = $this->driver === 'postgres';
        foreach ($args as $i => $v) {
            if (is_bool($v)) {
                $pg ? $st->bindValue($i + 1, $v, \PDO::PARAM_BOOL) : $st->bindValue($i + 1, (int) $v, \PDO::PARAM_INT);
            } elseif ($v instanceof Bytes) {
                $st->bindValue($i + 1, $v->bytes, \PDO::PARAM_LOB);
            } elseif ($v === null) {
                $st->bindValue($i + 1, null, \PDO::PARAM_NULL);
            } elseif (is_int($v) && !$pg) {
                $st->bindValue($i + 1, $v, \PDO::PARAM_INT);
            } else {
                $st->bindValue($i + 1, is_string($v) ? $v : (string) $v);
            }
        }
        $st->execute();
    }

    private function failed(?\PDOStatement $st, \PDOException $e): \Throwable
    {
        try {
            $st?->closeCursor();
        } catch (\PDOException) {
            // the reset reports the failed step again on some drivers
        }
        return OrmException::fromDriver($e, $this->driver);
    }

    private function emit(string $sql, array $args, float $start, string $planId, ?\Throwable $err): void
    {
        $hook = $this->config->onQuery;
        if ($hook === null) {
            return;
        }
        foreach ($args as $i => $v) {
            if ($v instanceof Bytes) {
                $args[$i] = $v->bytes;
            }
        }
        foreach ($this->masks as $i => $mask) {
            $args[$i] = $mask;
        }
        $hook($sql, $args, microtime(true) - $start, $planId, $err);
    }

    /** @internal takes the ORM lock row that stands for SQLite row locks */
    public function acquireSQLiteRowLock(string $mode): void
    {
        if ($mode === '' || $this->driver !== 'sqlite') {
            return;
        }
        $noWait = str_ends_with($mode, '_nowait');
        $previous = (int) $this->pdo->query('PRAGMA busy_timeout')->fetchColumn();
        try {
            if ($noWait) {
                $this->pdo->exec('PRAGMA busy_timeout=0');
            }
            $this->pdo->exec('INSERT INTO "orm__row_lock" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "id" = excluded."id"');
        } catch (\PDOException $e) {
            $mapped = OrmException::fromDriver($e, $this->driver);
            if ($noWait && $mapped instanceof OrmException && $mapped->code_ === Code::DEADLOCK) {
                throw new OrmException(Code::LOCK_NOT_AVAILABLE, $e->getMessage(), $e);
            }
            throw $mapped;
        } finally {
            if ($noWait) {
                $this->pdo->exec('PRAGMA busy_timeout=' . $previous);
            }
        }
    }

    /** @return list<list<mixed>> positional rows with styled cells decoded */
    private function query(array $step, array $params, ?string $sql = null, array $parentVals = []): array
    {
        $sql ??= $step['sql'];
        $args = $this->args($step, $params, $parentVals);
        $start = microtime(true);
        $st = null;
        try {
            $st = $this->stmt($sql);
            $this->exec($st, $args);
            $rows = $st->fetchAll(\PDO::FETCH_NUM);
            $st->closeCursor();
        } catch (\PDOException $e) {
            $e = $this->failed($st, $e);
            $this->emit($sql, $args, $start, $step['plan_id'], $e);
            throw $e;
        }
        $this->emit($sql, $args, $start, $step['plan_id'], null);
        if ($step['decode'] !== []) {
            Codec::decodeRows($rows, $step['decode'], $this->config);
        }
        return $rows;
    }

    private function scalar(array $step, array $params): mixed
    {
        $args = $this->args($step, $params);
        $start = microtime(true);
        $st = null;
        try {
            $st = $this->stmt($step['sql']);
            $this->exec($st, $args);
            $v = $st->fetchColumn();
            $st->closeCursor();
        } catch (\PDOException $e) {
            $e = $this->failed($st, $e);
            $this->emit($step['sql'], $args, $start, $step['plan_id'], $e);
            throw $e;
        }
        $this->emit($step['sql'], $args, $start, $step['plan_id'], null);
        return $v === false ? null : $v;
    }

    /** @return array{main: list<list<mixed>>, steps: array<int, array>, params: list<mixed>} */
    private function relations(array $plan, array $params, array $main): array
    {
        $out = ['main' => $main, 'steps' => [], 'params' => $params];
        foreach ($plan['steps'] as $st) {
            if (($st['role'] ?? '') !== 'relation') {
                continue;
            }
            $pr = $st['parent'];
            $parents = $pr['step'] === 0 ? $main : $out['steps'][$pr['step']]['data'];
            $vals = self::parentValues($pr, $parents, $params);
            $sr = ['step' => $st, 'data' => [], 'byKey' => []];
            if ($vals !== []) {
                foreach (self::relationChunks($st, $vals, $this->driver) as $chunk) {
                    [$sql, $chunk] = self::expandIn($st, $chunk);
                    array_push($sr['data'], ...$this->query($st, $params, $sql, $chunk));
                }
                $keys = self::childKeys($plan, $st['id']);
                foreach ($sr['data'] as $j => $row) {
                    $key = self::rowKey($row, $keys);
                    if ($key !== null) {
                        $sr['byKey'][$key][] = $j;
                    }
                }
            }
            $out['steps'][$st['id']] = $sr;
        }
        return $out;
    }

    private static function parentValues(array $pr, array $parents, array $params): array
    {
        $seen = [];
        $out = [];
        $ifp = $pr['if_parent'] ?? null;
        foreach ($parents as $row) {
            if ($ifp !== null && !self::sameScalar($row[$ifp['index']], $params[$ifp['param']])) {
                continue;
            }
            $key = self::rowKey($row, $pr['keys']);
            if ($key === null || isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            foreach ($pr['keys'] as $ref) {
                $out[] = $row[$ref['index']];
            }
        }
        return $out;
    }

    /**
     * Rewrites the single parent placeholder into a list padded to a power of
     * two. On PostgreSQL every later placeholder number shifts.
     * @return array{0: string, 1: list<mixed>}
     */
    private static function expandIn(array $step, array $vals): array
    {
        $width = count($step['parent']['keys']);
        $tuples = intdiv(count($vals), $width);
        $n = 1;
        while ($n < $tuples) {
            $n <<= 1;
        }
        $last = array_slice($vals, ($tuples - 1) * $width, $width);
        while (count($vals) < $n * $width) {
            array_push($vals, ...$last);
        }
        $src = $step['sql'];
        if (str_contains($src, '$1')) {
            $parent = -1;
            foreach ($step['bind_slots'] as $i => $b) {
                if ($b['from'] === 'parent') {
                    $parent = $i + 1;
                }
            }
            $sql = preg_replace_callback('/\$(\d+)/', static function (array $m) use ($parent, $n, $width): string {
                $k = (int) $m[1];
                if ($k === $parent) {
                    $groups = [];
                    for ($t = 0; $t < $n; $t++) {
                        $parts = [];
                        for ($p = 0; $p < $width; $p++) {
                            $parts[] = '$' . ($k + $t * $width + $p);
                        }
                        $groups[] = implode(', ', $parts);
                    }
                    return implode($width === 1 ? ', ' : '), (', $groups);
                }
                return $k > $parent ? '$' . ($k + $n * $width - 1) : $m[0];
            }, $src);
            return [$sql, $vals];
        }
        $sql = '';
        $slot = 0;
        for ($i = 0, $len = strlen($src); $i < $len; $i++) {
            if ($src[$i] !== '?') {
                $sql .= $src[$i];
                continue;
            }
            if ($step['bind_slots'][$slot]['from'] === 'parent') {
                $sql .= implode($width === 1 ? ', ' : '), (', array_fill(0, $n, implode(', ', array_fill(0, $width, '?'))));
            } else {
                $sql .= '?';
            }
            $slot++;
        }
        return [$sql, $vals];
    }

    private static function relationChunks(array $step, array $vals, string $driver): array
    {
        $width = count($step['parent']['keys']);
        $nonParent = count(array_filter($step['bind_slots'] ?? [], static fn(array $b): bool => $b['from'] !== 'parent'));
        $maxTuples = intdiv(self::bindLimit($driver) - $nonParent, $width);
        if ($maxTuples < 1) {
            throw new OrmException(Code::IR_INVALID, "relation {$step['id']} needs more bind parameters than $driver permits");
        }
        $chunk = 1;
        while ($chunk * 2 <= $maxTuples) {
            $chunk *= 2;
        }
        return array_chunk($vals, $chunk * $width);
    }

    private static function childKeys(array $plan, int $id): array
    {
        $find = function (array $a) use (&$find, $id): ?array {
            foreach ($a['children'] ?? [] as $ch) {
                if ($ch['kind'] !== 'join' && $ch['step'] === $id) {
                    return $ch['child_keys'];
                }
                if ($ch['kind'] === 'join' && ($keys = $find($ch['assemble'])) !== null) {
                    return $keys;
                }
            }
            return null;
        };
        foreach ($plan['steps'] as $st) {
            if (isset($st['assemble']) && ($keys = $find($st['assemble'])) !== null) {
                return $keys;
            }
        }
        throw new OrmException(Code::INTERNAL, "relation step $id without a child");
    }

    /**
     * Splits a root IN list that exceeds the driver bind limit into requests
     * whose results together equal the original result.
     * @return list<Request>
     */
    private function rootInParts(Request $r, array $step): array
    {
        $limit = self::bindLimit($this->driver);
        if (count($step['bind_slots'] ?? []) <= $limit) {
            return [];
        }
        $tooLarge = new OrmException(Code::IR_INVALID, 'the statement needs ' . count($step['bind_slots']) . " bind parameters but {$this->driver} permits $limit");
        $ir = $r->ir;
        $items = $ir['where']['items'] ?? [];
        if (isset($ir['limit']) || isset($ir['order']) || isset($ir['group_by']) || isset($ir['group_by_expr']) || $items === []) {
            throw $tooLarge;
        }
        $target = -1;
        foreach ($items as $i => $item) {
            if (!isset($item['pred'])) {
                continue;
            }
            $next = $items[$i + 1] ?? null;
            $nextConn = $next === null ? '' : (reset($next)['conn'] ?? '');
            if (($item['pred']['conn'] ?? '') === 'or' || $nextConn === 'or') {
                throw $tooLarge;
            }
            if ($item['pred']['op'] === 'in' && !isset($item['pred']['sub']) && ($target < 0 || count($item['pred']['ps']) > count($items[$target]['pred']['ps']))) {
                $target = $i;
            }
        }
        if ($target < 0) {
            throw $tooLarge;
        }
        $ps = $items[$target]['pred']['ps'];
        $available = $limit - (count($step['bind_slots']) - count($ps));
        if ($available < 1) {
            throw $tooLarge;
        }
        $chunk = 1;
        while ($chunk * 2 <= $available) {
            $chunk *= 2;
        }
        $seen = [];
        $unique = [];
        foreach ($ps as $p) {
            $k = self::scalarText($r->params[$p]);
            if (!isset($seen[$k])) {
                $seen[$k] = true;
                $unique[] = $p;
            }
        }
        $parts = [];
        foreach (array_chunk($unique, $chunk) as $group) {
            $part = clone $r;
            $part->ir['where']['items'][$target]['pred']['ps'] = Request::padIn($group);
            $parts[] = $part;
        }
        return $parts;
    }

    /** @param list<mixed> $row @param list<array{column:string,index:int}> $refs */
    public static function rowKey(array $row, array $refs): int|string|null
    {
        if (count($refs) === 1) {
            $v = $row[$refs[0]['index']];
            return $v === null ? null : Collection::keyOf($v);
        }
        $out = '';
        foreach ($refs as $ref) {
            $v = $row[$ref['index']];
            if ($v === null) {
                return null;
            }
            $part = self::scalarText($v);
            $out .= strlen($part) . ':' . $part;
        }
        return $out;
    }

    public static function sameScalar(mixed $a, mixed $b): bool
    {
        return self::scalarText($a) === self::scalarText($b);
    }

    public static function scalarText(mixed $v): string
    {
        return match (true) {
            $v === null => "\0",
            is_bool($v) => $v ? '1' : '0',
            $v instanceof \DateTimeInterface => $v->format('Y-m-d H:i:s.u'),
            default => (string) $v,
        };
    }
}

/** @internal one active transaction */
final class TxFrame
{
    public bool $finished = false;
    public int $savepoints = 0;
    /** @var array<string, string> */
    public array $locals = [];
    /** @var list<string> */
    public array $locks = [];
    public bool $contextRow = false;

    public function __construct(public readonly Db $db, public readonly bool $readOnly, public readonly string $isolation) {}
}

final class Transform
{
    /** Executor-side value transforms, identical in every client. */
    public static function apply(string $kind, string $s): string
    {
        switch ($kind) {
            case 'fulltext_boolean':
                $s = trim($s);
                return $s === '' ? $s : '+' . str_replace(' ', ' +', $s) . '*';
            case 'like_contains':
                return '%' . self::esc($s) . '%';
            case 'like_starts':
                return self::esc($s) . '%';
            case 'like_ends':
                return '%' . self::esc($s);
        }
        return $s;
    }

    private static function esc(string $s): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
    }
}
