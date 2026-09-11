<?php
declare(strict_types=1);

namespace Orm;

/**
 * The PDO executor: prepared-statement cache, bind resolution, transactions
 * with deadlock re-run. Terminals take a Db or a Tx.
 */
class Db
{
    /** @var array<string, \PDOStatement> */
    private array $stmts = [];

    public function __construct(public readonly \PDO $pdo)
    {
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(\PDO::ATTR_EMULATE_PREPARES, false);
        $pdo->setAttribute(\PDO::ATTR_STRINGIFY_FETCHES, false);
    }

    /** Open a MySQL connection the way compatibility does (FOUND_ROWS on, persistent, utf8mb4). */
    public static function mysql(string $dsn, string $user, string $password, bool $persistent = true): self
    {
        $opts = [
            \PDO::ATTR_PERSISTENT => $persistent,
            \Pdo\Mysql::ATTR_FOUND_ROWS => true,
        ];
        return new self(new \PDO($dsn, $user, $password, $opts));
    }

    public function db(): Db
    {
        return $this;
    }

    public function stmt(string $sql): \PDOStatement
    {
        return $this->stmts[$sql] ??= $this->pdo->prepare($sql);
    }

    /**
     * Run $fn inside a transaction. An exception rolls back. On a deadlock the
     * closure is re-run in a new transaction (compatibility behaviour), at most 3 times.
     * @template T
     * @param \Closure(Tx): T $fn
     * @return T
     */
    public function transaction(\Closure $fn): mixed
    {
        $last = null;
        for ($attempt = 0; $attempt < 3; $attempt++) {
            $this->pdo->beginTransaction();
            try {
                $v = $fn(new Tx($this));
                $this->pdo->commit();
                return $v;
            } catch (\Throwable $e) {
                if ($this->pdo->inTransaction()) {
                    $this->pdo->rollBack();
                }
                if (!self::isDeadlock($e)) {
                    throw $e;
                }
                $last = $e;
                usleep((50000 << $attempt) + random_int(0, 20000));
            }
        }
        throw $last;
    }

    public static function isDeadlock(\Throwable $e): bool
    {
        $m = $e->getMessage();
        return str_contains($m, '1213') || str_contains($m, '40001') || stripos($m, 'deadlock') !== false;
    }

    // ---- execution ----

    /**
     * @param list<mixed> $params request params; @param list<mixed> $parentVals values for the step's `parent` slot
     * @param bool $maskSecrets render secret slots as "$SECRET" (sql() dumps) instead of the configured key
     */
    private function args(array $step, array $params, array $parentVals = [], bool $maskSecrets = false): array
    {
        $out = [];
        foreach ($step['bind_slots'] as $b) {
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
                    }
                    $out[] = $v;
                    break;
                case 'secret':
                    if ($maskSecrets) {
                        $out[] = '$SECRET';
                        break;
                    }
                    $key = Orm::config()->aesKey;
                    if (($b['name'] ?? '') !== 'aes' || $key === '') {
                        throw new OrmException('CONFIG', "secret {$b['name']} not configured");
                    }
                    $out[] = $key;
                    break;
                default:
                    throw new OrmException('INTERNAL', "bind from {$b['from']}");
            }
        }
        return $out;
    }

    /**
     * What a step would run, without running it: the SQL and its binds with secrets masked
     * (the sql() terminal). Relation steps are not dumped, so no parent values are expanded.
     * @return array{sql: string, binds: list<mixed>}
     */
    public function sqlOf(array $step, array $params): array
    {
        return ['sql' => $step['sql'], 'binds' => $this->args($step, $params, [], true)];
    }

    private function emit(string $sql, array $args, float $start, ?\Throwable $err): void
    {
        $hook = Orm::config()->onQuery;
        if ($hook !== null) {
            $hook($sql, $args, microtime(true) - $start, $err);
        }
    }

    /** @return array{0: list<list<mixed>>, 1: array} rows (positional) and the assemble node */
    public function query(array $step, array $params, ?string $sql = null, array $parentVals = []): array
    {
        $sql ??= $step['sql'];
        $st = $this->stmt($sql);
        $args = $this->args($step, $params, $parentVals);
        $start = microtime(true);
        try {
            $st->execute($args);
            $rows = $st->fetchAll(\PDO::FETCH_NUM);
            $st->closeCursor();
        } catch (\Throwable $e) {
            $this->emit($sql, $args, $start, $e);
            throw $e;
        }
        $this->emit($sql, $args, $start, null);
        if (Codec::hasStyled($step['assemble'])) {
            foreach ($rows as &$vals) {
                Codec::decodeRow($vals, $step['assemble']);
            }
            unset($vals);
        }
        return [$rows, $step['assemble']];
    }

    /** Runs a select plan: the main step, then every relation step bound to its parent's rows. */
    public function runPlan(array $plan, array $params): Rows
    {
        $st0 = $plan['steps'][0];
        [$data] = $this->query($st0, $params);
        $rows = new Rows($plan, $st0['assemble'], $data, $params);
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
                [$sr['data']] = $this->query($st, $params, $sql, $vals);
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
     * statement per size class.
     * @return array{0: string, 1: list<mixed>}
     */
    private static function expandIn(array $step, array $vals): array
    {
        $n = 1;
        while ($n < count($vals)) {
            $n <<= 1;
        }
        $vals = array_pad($vals, $n, $vals[count($vals) - 1]);
        $sql = '';
        $slot = 0;
        $src = $step['sql'];
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
        throw new OrmException('INTERNAL', "relation step $id without a child spec");
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

    public function scalar(array $step, array $params): mixed
    {
        $st = $this->stmt($step['sql']);
        $args = $this->args($step, $params);
        $start = microtime(true);
        try {
            $st->execute($args);
            $v = $st->fetchColumn();
            $st->closeCursor();
        } catch (\Throwable $e) {
            $this->emit($step['sql'], $args, $start, $e);
            throw $e;
        }
        $this->emit($step['sql'], $args, $start, null);
        return $v;
    }

    /** @return array{0: int|string|null lastInsertId, 1: int affected} */
    public function write(array $step, array $params, bool $insert, bool $optimistic): array
    {
        $st = $this->stmt($step['sql']);
        $args = $this->args($step, $params);
        $start = microtime(true);
        try {
            $st->execute($args);
            $affected = $st->rowCount();
            $id = $insert ? $this->pdo->lastInsertId() : null;
        } catch (\Throwable $e) {
            $this->emit($step['sql'], $args, $start, $e);
            throw $e;
        }
        $this->emit($step['sql'], $args, $start, null);
        if ($optimistic && $affected === 0) {
            throw new OrmException('OPTIMISTIC_LOCK', 'row changed since it was read');
        }
        return [$id, $affected];
    }
}

/** A transaction handle: same executor, marks statements as inside the transaction. */
final class Tx extends Db
{
    public function __construct(private readonly Db $outer)
    {
        parent::__construct($outer->pdo);
    }

    public function db(): Db
    {
        return $this->outer;
    }

    public function stmt(string $sql): \PDOStatement
    {
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
