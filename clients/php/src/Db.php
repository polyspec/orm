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

    /** @param array $plan compiled plan; @param list<mixed> $params */
    private function args(array $step, array $params): array
    {
        $out = [];
        foreach ($step['bind_slots'] as $b) {
            switch ($b['from']) {
                case 'param':
                    $v = $params[$b['param']];
                    if (!empty($b['transform'])) {
                        $v = Transform::apply($b['transform'], (string) $v);
                    }
                    $out[] = $v;
                    break;
                case 'secret':
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

    private function emit(string $sql, array $args, float $start, ?\Throwable $err): void
    {
        $hook = Orm::config()->onQuery;
        if ($hook !== null) {
            $hook($sql, $args, microtime(true) - $start, $err);
        }
    }

    /** @return array{0: list<list<mixed>>, 1: array} rows (positional) and the assemble node */
    public function query(array $step, array $params): array
    {
        $st = $this->stmt($step['sql']);
        $args = $this->args($step, $params);
        $start = microtime(true);
        try {
            $st->execute($args);
            $rows = $st->fetchAll(\PDO::FETCH_NUM);
            $st->closeCursor();
        } catch (\Throwable $e) {
            $this->emit($step['sql'], $args, $start, $e);
            throw $e;
        }
        $this->emit($step['sql'], $args, $start, null);
        return [$rows, $step['assemble']];
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
