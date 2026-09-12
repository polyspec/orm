<?php
declare(strict_types=1);

namespace Orm;

/**
 * The PDO executor: prepared-statement cache, bind resolution, transactions
 * with deadlock re-run. Queries and loaded rows bind a Db or a Tx.
 */
class Db
{
    /**
     * Decided by measurement (clients/php/tests/bench_emulate.php, S5, p50 µs, off → on):
     * cold (prepare + execute, what a PHP-FPM request pays once per statement shape since
     * PDOStatements do not outlive the request): pk 72 → 48, IN(8) 107 → 75, 100 rows 460 → 382;
     * warm (statement reused in-process): pk 33 → 49, IN(8) 75 → 84, 100 rows 435 → 400.
     * Web requests run most shapes once, so emulation wins; a CLI loop re-running one small
     * statement pays ~15µs more per execution (the server re-parses the text protocol query).
     * Types are unchanged: mysqlnd returns native ints/floats, INET6_NTOA strings and JSON text
     * in both modes (the conformance runner prints identical output). The DSN must carry
     * charset=utf8mb4: the client-side quoting uses the connection charset.
     */
    public const EMULATE_PREPARES = true;

    /** the databases a Db can speak; the plans are dialect text, so ormd runs with the same `-dialect` */
    public const DRIVERS = ['mysql', 'postgres', 'sqlite'];
    /** what the on_query hook and sql() show in place of a secret / `now` bind */
    public const SECRET = '$SECRET';
    public const NOW = '$NOW';

    /** @var array<string, \PDOStatement> */
    private array $stmts = [];
    /** @var array<int, string> positions in the last args() result the on_query hook masks (secret → "$SECRET", now → "$NOW") */
    private array $masks = [];
    /**
     * whether the last args() result needs typed binding: a bool (PDO sends '' / '1' as text; MySQL wants 0 / 1,
     * PostgreSQL a boolean, SQLite an integer), a Bytes (bytea / BLOB), or SQLite at all (an int bound as text
     * compares as text against an expression without affinity: COUNT(*) > '1' is never true)
     */
    private bool $typed = false;
    private readonly Transport $compiler;

    public function __construct(public readonly \PDO $pdo, private readonly string $driver = 'mysql', ?Transport $compiler = null)
    {
        if (!in_array($driver, self::DRIVERS, true)) {
            throw new OrmException(Code::CONFIG, "driver $driver: want mysql, postgres or sqlite");
        }
        if (($cfg = Orm::config())->driver !== $driver) {
            throw new OrmException(Code::CONFIG, "Db speaks $driver but Orm::init was given driver {$cfg->driver}");
        }
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        // pdo_pgsql / pdo_sqlite prepare natively: the plan's placeholders reach the server, types come from the column
        $pdo->setAttribute(\PDO::ATTR_EMULATE_PREPARES, $driver === 'mysql' && self::EMULATE_PREPARES);
        $pdo->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, false);
        $this->compiler = $compiler ?? Orm::transport();
    }

    /** Open a MySQL connection with FOUND_ROWS, persistence, and utf8mb4 enabled. */
    public static function mysql(string $dsn, string $user, string $password, bool $persistent = true): self
    {
        $opts = [
            \PDO::ATTR_PERSISTENT => $persistent,
            \Pdo\Mysql::ATTR_FOUND_ROWS => true,
        ];
        try {
            return new self(new \PDO($dsn, $user, $password, $opts), 'mysql');
        } catch (\PDOException $e) {
            throw new OrmException(Code::CONFIG, 'cannot connect: ' . $e->getMessage(), $e);
        }
    }

    /**
     * Open a PostgreSQL connection (pdo_pgsql): `pgsql:host=…;port=…;dbname=…[;user=…]`. The user and password
     * may come from the DSN instead. Booleans are bound as booleans, ints as ints, binary values as bytea;
     * the rows come back typed (bool, int; numeric as text, jsonb and inet as text, bytea as a stream the codec reads).
     */
    public static function postgres(string $dsn, ?string $user = null, ?string $password = null, bool $persistent = true): self
    {
        try {
            return new self(new \PDO($dsn, $user, $password, [\PDO::ATTR_PERSISTENT => $persistent]), 'postgres');
        } catch (\PDOException $e) {
            throw new OrmException(Code::CONFIG, 'cannot connect: ' . $e->getMessage(), $e);
        }
    }

    /**
     * Open a SQLite database file (pdo_sqlite; the path is absolute and declared, as every path here).
     * busy_timeout 5s and WAL are set on open so concurrent writers wait instead of failing at once;
     * a lock that still cannot be taken is SQLITE_BUSY, mapped to DEADLOCK and re-run by transaction().
     * Datetimes are text with six fraction digits (docs/dialects.md); the executor binds them in that form.
     */
    public static function sqlite(string $path, bool $persistent = true): self
    {
        if (!str_starts_with($path, '/')) {
            throw new OrmException(Code::CONFIG, "sqlite path must be absolute: $path");
        }
        try {
            $pdo = new \PDO('sqlite:' . $path, null, null, [\PDO::ATTR_PERSISTENT => $persistent]);
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $pdo->exec('PRAGMA busy_timeout=5000');
            $pdo->exec('PRAGMA journal_mode=WAL');
            return new self($pdo, 'sqlite');
        } catch (\PDOException $e) {
            throw new OrmException(Code::CONFIG, 'cannot open: ' . $e->getMessage(), $e);
        }
    }

    /** The database this Db talks to (mysql | postgres | sqlite). */
    public function driver(): string
    {
        return $this->driver;
    }

    public function db(): Db
    {
        return $this;
    }

    public function planFor(Req $req, string $kind): array
    {
        return $this->compiler->planFor($req, $kind);
    }

    public function compiler(): Transport
    {
        return $this->compiler;
    }

    public function stmt(string $sql): \PDOStatement
    {
        return $this->stmts[$sql] ??= $this->pdo->prepare($this->driver === 'postgres' ? self::questionMarks($sql) : $sql);
    }

    /**
     * pdo_pgsql numbers placeholders itself and binds nothing to a `$n` it did not write, so a PostgreSQL
     * statement is prepared from its `?` form: the plan has one `$k` per bind slot in slot order, so the
     * positional binds line up. The dialect text is what the cache key, the hook and sql() show.
     */
    private static function questionMarks(string $sql): string
    {
        return preg_replace('/\$\d+/', '?', $sql);
    }

    /**
     * Run $fn inside a transaction. An exception rolls back. On a deadlock the
     * closure is re-run in a new transaction, at most 3 times.
     * @template T
     * @param \Closure(Tx): T $fn
     * @return T
     */
    public function transaction(\Closure $fn): mixed
    {
        $last = null;
        for ($attempt = 0; $attempt < 3; $attempt++) {
            $this->pdo->beginTransaction();
            $tx = new Tx($this);
            try {
                $v = $fn($tx);
                $this->pdo->commit();
                return $v;
            } catch (\Throwable $e) {
                if ($this->pdo->inTransaction()) {
                    $this->pdo->rollBack();
                }
                if ($e instanceof \PDOException) {
                    $e = OrmException::fromDriver($e, $this->driver);
                }
                if (!self::isDeadlock($e)) {
                    throw $e;
                }
                $last = $e;
                usleep((50000 << $attempt) + random_int(0, 20000));
            } finally {
                $tx->finish();
            }
        }
        throw $last;
    }

    /** @param array{table:string, primary_key:string, version_column:string, columns:list<array{name:string,styles:list<string>}>} $spec */
    public function aesStatus(array $spec, AesKeyring $keyring): AesRotationStatus
    {
        $table = $this->aesIdentifier($spec['table']);
        $version = $this->aesIdentifier($spec['version_column']);
        $st = $this->stmt("SELECT $version, COUNT(*) FROM $table GROUP BY $version ORDER BY $version");
        $st->execute();
        $versions = []; $total = 0; $pending = 0;
        while (($row = $st->fetch(\PDO::FETCH_NUM)) !== false) {
            if ((!is_int($row[0]) && (!is_string($row[0]) || !ctype_digit($row[0])))
                || (!is_int($row[1]) && (!is_string($row[1]) || !ctype_digit($row[1])))) {
                throw new OrmException(Code::CODEC_DECODE, 'AES rotation status contains a non-integer value');
            }
            $stored = (int) $row[0]; $count = (int) $row[1];
            if ($stored < 1 || $count < 0) {
                throw new OrmException(Code::CODEC_DECODE, 'AES rotation status contains an invalid value');
            }
            $versions[$stored] = $count; $total += $count;
            if ($stored !== $keyring->currentVersion) { $pending += $count; }
        }
        $st->closeCursor();
        return new AesRotationStatus($keyring->currentVersion, $total, $pending, $versions);
    }

    /** @param array{table:string, primary_key:string, version_column:string, columns:list<array{name:string,styles:list<string>}>} $spec */
    public function rotateAESRows(array $spec, AesKeyring $keyring): int
    {
        if (!($this instanceof Tx)) {
            return $this->transaction(fn(Tx $tx): int => $tx->rotateAESRows($spec, $keyring));
        }
        $table = $this->aesIdentifier($spec['table']);
        $primary = $this->aesIdentifier($spec['primary_key']);
        $version = $this->aesIdentifier($spec['version_column']);
        $columns = $spec['columns'];
        if ($columns === []) { throw new OrmException(Code::CONFIG, 'AES rotation columns are empty'); }
        $names = array_map(fn(array $column): string => $this->aesIdentifier($column['name']), $columns);
        $select = $this->stmt("SELECT $primary, $version, " . implode(', ', $names) . " FROM $table WHERE $version <> ? ORDER BY $primary");
        $select->execute([$keyring->currentVersion]);
        $rows = $select->fetchAll(\PDO::FETCH_NUM);
        $select->closeCursor();
        $sets = array_map(fn(string $name): string => "$name = ?", $names);
        $sets[] = "$version = ?";
        $update = $this->stmt("UPDATE $table SET " . implode(', ', $sets) . " WHERE $primary = ? AND $version = ?");
        $count = 0;
        foreach ($rows as $values) {
            $row = [$spec['primary_key'] => $values[0], $spec['version_column'] => (int) $values[1]];
            foreach ($columns as $index => $column) { $row[$column['name']] = $values[$index + 2]; }
            $rotated = $keyring->rotateRow($row, $spec['version_column'], $columns, $keyring->currentVersion);
            $args = [];
            foreach ($columns as $column) { $value = $rotated[$column['name']]; $args[] = $value instanceof Bytes ? $value->data : $value; }
            $args[] = $keyring->currentVersion; $args[] = $values[0]; $args[] = (int) $values[1];
            $update->execute($args);
            if ($update->rowCount() !== 1) { throw new OrmException(Code::OPTIMISTIC_LOCK, "AES rotation changed {$spec['table']} primary key {$values[0]}"); }
            $count++;
        }
        return $count;
    }

    private function aesIdentifier(string $value): string
    {
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $value)) { throw new OrmException(Code::CONFIG, "invalid generated identifier $value"); }
        return $this->driver === 'mysql' ? "`$value`" : "\"$value\"";
    }

    public static function isDeadlock(\Throwable $e): bool
    {
        return $e instanceof OrmException && $e->code_ === Code::DEADLOCK;
    }

    // ---- execution ----

    /**
     * @param list<mixed> $params request params; @param list<mixed> $parentVals values for the step's `parent` slot
     * @param bool $dump render secret slots as "$SECRET" and now slots as "$NOW" (sql() dumps) instead of their values
     */
    private function args(array $step, array $params, array $parentVals = [], bool $dump = false): array
    {
        $out = [];
        $this->masks = [];
        $this->typed = $this->driver === 'sqlite';
        $cfg = Orm::config();
        foreach ($step['bind_slots'] ?? [] as $b) {
            switch ($b['from']) {
                case 'parent':
                    foreach ($parentVals as $v) {
                        $out[] = $v;
                    }
                    break;
                case 'param':
                    $v = $params[$b['param']];
                    if (!empty($b['transform'])) {
                        $v = Transform::apply($b['transform'], (string) $v);
                    } elseif (!empty($b['host_styles'])) {
                        // the stages this dialect cannot run in SQL (aes/hex on PostgreSQL, plus ip on SQLite)
                        $v = Codec::hostEncode($v, $b['host_styles'], $cfg->aesKey);
                        $this->typed = $this->typed || $v instanceof Bytes;
                    } elseif (is_bool($v) || $v instanceof Bytes) {
                        $this->typed = true;
                    }
                    if ($this->driver === 'sqlite' && !empty($b['col_type'])) {
                        $v = $this->sqliteTime($v);
                    }
                    if (($b['col_type'] ?? '') === 'point' && $v !== null) {
                        $v = $this->driver === 'postgres' ? Codec::postgresPointText($v) : Codec::pointText($v);
                    }
                    $out[] = $v;
                    break;
                case 'secret':
                    if ($dump) {
                        $out[] = self::SECRET;
                        break;
                    }
                    $this->masks[count($out)] = self::SECRET;
                    if (($b['name'] ?? '') === 'aes' && $cfg->aesKey !== '') {
                        $out[] = $cfg->aesKey;
                    } else {
                        throw new OrmException(Code::CONFIG, "secret {$b['name']} not configured");
                    }
                    break;
                case 'config':
                    if (($b['name'] ?? '') !== 'aes_version') {
                        throw new OrmException(Code::CONFIG, "config value {$b['name']} not configured");
                    }
                    $out[] = $cfg->aesVersion;
                    break;
                case 'now':
                    // dialects without a microsecond clock function (SQLite) get the timestamp from the executor;
                    // hooks see "$NOW" so logs and recorded vectors stay deterministic
                    if ($dump) {
                        $out[] = self::NOW;
                        break;
                    }
                    $this->masks[count($out)] = self::NOW;
                    $out[] = self::now();
                    break;
                default:
                    throw new OrmException(Code::INTERNAL, "bind from {$b['from']}");
            }
        }
        return $out;
    }

    /**
     * SQLite stores what it is given, and PHP has no datetime type: a value bound for a
     * date/time column (the plan's slot says so — never a bare string that merely looks
     * like a timestamp) is written in the canonical text form every reader parses
     * (docs/dialects.md), so it reads back equal to one written by Go or Rust.
     */
    private function sqliteTime(mixed $v): mixed
    {
        if ($v instanceof \DateTimeInterface) {
            return \DateTimeImmutable::createFromInterface($v)->setTimezone(self::utc())->format('Y-m-d H:i:s.u');
        }
        if (is_string($v) && preg_match('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?$/', $v)) {
            return str_pad(strlen($v) === 19 ? "$v." : $v, 26, '0');
        }
        return $v;
    }

    private static ?\DateTimeZone $utc = null;

    private static function utc(): \DateTimeZone
    {
        return self::$utc ??= new \DateTimeZone('UTC');
    }

    /** The `now` bind: UTC with microseconds, the text form SQLite datetimes are kept in. */
    public static function now(): string
    {
        return (new \DateTimeImmutable('now', self::utc()))->format('Y-m-d H:i:s.u');
    }

    /**
     * What a step would run, without running it: the SQL and its binds with secrets masked as "$SECRET"
     * and now slots as "$NOW" (the sql() terminal). Relation steps are not dumped, so no parent values are expanded.
     * @return array{sql: string, binds: list<mixed>}
     */
    public function sqlOf(array $step, array $params): array
    {
        return ['sql' => $step['sql'], 'binds' => array_map(static fn(mixed $v) => $v instanceof Bytes ? $v->bytes : $v, $this->args($step, $params, [], true))];
    }

    /**
     * execute() with the binds typed where the driver needs it. MySQL (emulated prepares): bools as 0/1 — PDO
     * would interpolate false as '', which strict MySQL rejects for an int column. PostgreSQL: bools as
     * PARAM_BOOL, Bytes as PARAM_LOB (bytea, binary format); everything else stays untyped text the server
     * resolves from the column. SQLite: ints and bools as PARAM_INT, Bytes as PARAM_LOB, null as PARAM_NULL.
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

    /**
     * A statement that failed (at prepare — pdo_sqlite parses eagerly — or at execute): mapped to the catalog's
     * code (docs/errors.yaml) and reset — pdo_sqlite leaves a statement that failed at step time un-reset, and
     * binding to it again is SQLITE_MISUSE; the cached statement is re-run by transaction() after a DEADLOCK
     * and by the next call of the same shape.
     */
    private function failed(?\PDOStatement $st, \PDOException $e): \Throwable
    {
        try {
            $st?->closeCursor();
        } catch (\PDOException) {
            // the reset itself reports the failed step again on some drivers; the original error is the one to surface
        }
        return OrmException::fromDriver($e, $this->driver);
    }

    /** The on_query hook: (sql, binds with secrets masked as "$SECRET" and now slots as "$NOW", seconds, plan id, error). */
    private function emit(string $sql, array $args, float $start, string $planId, ?\Throwable $err): void
    {
        $hook = Orm::config()->onQuery;
        if ($hook !== null) {
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
    }

    /** @return list<list<mixed>> rows (positional); styled cells decoded */
    public function query(array $step, array $params, ?string $sql = null, array $parentVals = []): array
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
        if ($step['styled']) {
            foreach ($rows as &$vals) {
                Codec::decodeRow($vals, $step['assemble']);
            }
            unset($vals);
        }
        return $rows;
    }

    /** Runs a select plan: the main step, then every relation step bound to its parent's rows. */
    public function runPlan(array $plan, array $params): Rows
    {
        $st0 = $plan['steps'][0];
        $rows = new Rows($plan, $st0['assemble'], $this->query($st0, $params), $params);
        $rows->db = $this;
        foreach ($plan['steps'] as $st) {
            if (($st['role'] ?? '') !== 'relation') {
                continue;
            }
            $pr = $st['parent'];
            $parents = $pr['step'] === 0 ? $rows->data : $rows->steps[$pr['step']]['data'];
            $vals = self::parentValues($pr, $parents, $params);
            $sr = ['data' => [], 'byKey' => []];
            if ($vals !== []) {
                [$sql, $vals] = self::expandIn($st, $vals);
                $sr['data'] = $this->query($st, $params, $sql, $vals);
                $ci = self::childIndex($plan, $st['id']);
                foreach ($sr['data'] as $j => $row) {
                    $sr['byKey'][$row[$ci]][] = $j;
                }
            }
            $rows->steps[$st['id']] = $sr;
        }
        return $rows;
    }

    /** Distinct non-null values a relation step binds, first-seen order, from parents passing if_parent. */
    private static function parentValues(array $pr, array $parents, array $params): array
    {
        $seen = [];
        $out = [];
        $ifp = $pr['if_parent'] ?? null;
        foreach ($parents as $row) {
            if ($ifp !== null && !self::sameScalar($row[$ifp['index']], $params[$ifp['param']])) {
                continue;
            }
            $v = $row[$pr['index']];
            if ($v === null || isset($seen[$v])) {
                continue;
            }
            $seen[$v] = true;
            $out[] = $v;
        }
        return $out;
    }

    /**
     * Rewrites the step's single `parent` placeholder into n placeholders; n is rounded up
     * to a power of two (values padded by repetition) so the statement cache holds one
     * statement per size class. On PostgreSQL ($n placeholders, one per slot in slot order) the
     * parent slot becomes n numbered placeholders and every later number shifts by n - 1.
     * @return array{0: string, 1: list<mixed>}
     */
    private static function expandIn(array $step, array $vals): array
    {
        $n = 1;
        while ($n < count($vals)) {
            $n <<= 1;
        }
        $vals = array_pad($vals, $n, $vals[count($vals) - 1]);
        $src = $step['sql'];
        if (str_contains($src, '$1')) {
            $parent = -1;
            foreach ($step['bind_slots'] as $i => $b) {
                if ($b['from'] === 'parent') {
                    $parent = $i + 1;
                }
            }
            $sql = preg_replace_callback('/\$(\d+)/', static function (array $m) use ($parent, $n): string {
                $k = (int) $m[1];
                if ($k === $parent) {
                    $out = [];
                    for ($j = 0; $j < $n; $j++) {
                        $out[] = '$' . ($k + $j);
                    }
                    return implode(', ', $out);
                }
                return $k > $parent ? '$' . ($k + $n - 1) : $m[0];
            }, $src);
            return [$sql, $vals];
        }
        $sql = '';
        $slot = 0;
        for ($i = 0, $len = strlen($src); $i < $len; $i++) {
            $c = $src[$i];
            if ($c !== '?') {
                $sql .= $c;
                continue;
            }
            $sql .= $step['bind_slots'][$slot]['from'] === 'parent' ? '?' . str_repeat(', ?', $n - 1) : '?';
            $slot++;
        }
        return [$sql, $vals];
    }

    /** The match column of a relation step, from the child spec that references it. */
    private static function childIndex(array $plan, int $id): int
    {
        $find = function (array $a) use (&$find, $id): ?int {
            foreach ($a['children'] ?? [] as $ch) {
                if ($ch['kind'] !== 'join' && $ch['step'] === $id) {
                    return $ch['child_index'] ?? 0;
                }
                if ($ch['kind'] === 'join' && ($i = $find($ch['assemble'])) !== null) {
                    return $i;
                }
            }
            return null;
        };
        foreach ($plan['steps'] as $st) {
            if (isset($st['assemble']) && ($i = $find($st['assemble'])) !== null) {
                return $i;
            }
        }
        throw new OrmException(Code::INTERNAL, "relation step $id without a child spec");
    }

    /** Compares a row value with a bound value regardless of representation (bool/int/string). */
    public static function sameScalar(mixed $a, mixed $b): bool
    {
        return self::scalarKey($a) === self::scalarKey($b);
    }

    private static function scalarKey(mixed $v): string
    {
        return match (true) {
            $v === null => "\0",
            is_bool($v) => $v ? '1' : '0',
            default => (string) $v,
        };
    }

    /** Rows of a raw step keyed by the driver's column names; no codec, no assembly. @return list<array<string, mixed>> */
    public function rows(array $step, array $params): array
    {
        $args = $this->args($step, $params);
        $start = microtime(true);
        $st = null;
        try {
            $st = $this->stmt($step['sql']);
            $this->exec($st, $args);
            $rows = $st->fetchAll(\PDO::FETCH_ASSOC);
            $st->closeCursor();
        } catch (\PDOException $e) {
            $e = $this->failed($st, $e);
            $this->emit($step['sql'], $args, $start, $step['plan_id'], $e);
            throw $e;
        }
        $this->emit($step['sql'], $args, $start, $step['plan_id'], null);
        return $rows;
    }

    public function scalar(array $step, array $params): mixed
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
        return $v;
    }

    /** @return array{0: int|string|null lastInsertId, 1: int affected} */
    public function write(array $step, array $params, bool $insert, bool $optimistic): array
    {
        $args = $this->args($step, $params);
        $start = microtime(true);
        $st = null;
        try {
            $st = $this->stmt($step['sql']);
            $this->exec($st, $args);
            if ($insert && str_contains($step['sql'], ' RETURNING ')) {
                // PostgreSQL/SQLite: the id comes back as a row, not from the driver's last insert id
                $id = $st->fetchColumn();
                $st->closeCursor();
                $affected = 1;
            } else {
                $affected = $st->rowCount();
                $id = $insert ? $this->pdo->lastInsertId() : null;
            }
        } catch (\PDOException $e) {
            $e = $this->failed($st, $e);
            $this->emit($step['sql'], $args, $start, $step['plan_id'], $e);
            throw $e;
        }
        $this->emit($step['sql'], $args, $start, $step['plan_id'], null);
        if ($optimistic && $affected === 0) {
            throw new OrmException(Code::OPTIMISTIC_LOCK, 'row changed since it was read');
        }
        return [$id, $affected];
    }
}

/** A transaction handle: same executor, marks statements as inside the transaction. */
final class Tx extends Db
{
    private bool $finished = false;

    public function finish(): void { $this->finished = true; }

    public function assertActive(): void
    {
        if ($this->finished) {
            throw new OrmException(Code::CONFIG, 'transaction already finished');
        }
    }

    public function __construct(private readonly Db $outer)
    {
        parent::__construct($outer->pdo, $outer->driver(), $outer->compiler());
    }

    public function db(): Db
    {
        return $this->outer;
    }

    public function stmt(string $sql): \PDOStatement
    {
        $this->assertActive();
        return $this->outer->stmt($sql);
    }
}

final class Transform
{
    /** Executor-side value transforms; identical in Go/Rust/PHP. */
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
