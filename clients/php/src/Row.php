<?php
declare(strict_types=1);

namespace Orm;

/**
 * Base of every generated row class. Holds the positional values and a
 * reference to the assemble node's name→index map, so reads never copy.
 * Generated classes add typed getters/setters; ArrayAccess and getX($default)
 * are provided here for compatibility familiarity.
 */
abstract class Row implements \ArrayAccess
{
    /** @var list<mixed> */
    protected array $vals;
    /** @var array<string,int> */
    protected array $idx;
    /** @var array<string, mixed> joined / related rows by relation name */
    protected array $rel = [];
    /** @var array<string, mixed> columns changed through set* */
    protected array $dirty = [];
    protected bool $loaded = false;

    abstract public static function entity(): string;
    abstract public static function pk(): string;
    /** @return array<string,string> column => canonical type */
    abstract public static function columns(): array;

    /** @param list<mixed> $vals @param array $asm assemble node with 'idx' */
    public static function fromRow(array $vals, array $asm): static
    {
        $r = new static();
        $r->vals = $vals;
        $r->idx = $asm['idx'];
        $r->loaded = true;
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                $ca = $ch['assemble'];
                $pkIdx = $ca['columns'][0]['index'];
                $r->rel[$ch['rel']] = $vals[$pkIdx] === null ? null : Registry::row($ca['entity'])::fromRow($vals, $ca);
            }
        }
        return $r;
    }

    public function has(string $col): bool
    {
        return isset($this->idx[$col]) || array_key_exists($col, $this->dirty);
    }

    protected function col(string $col): mixed
    {
        if (array_key_exists($col, $this->dirty)) {
            return $this->dirty[$col];
        }
        if (!isset($this->idx[$col])) {
            if (isset(static::columns()[$col])) {
                return null; // declared but not selected (lazy) → null, as compatibility
            }
            throw new OrmException('COLUMN_UNKNOWN', static::entity() . ".$col");
        }
        $v = $this->vals[$this->idx[$col]];
        return $v === null ? null : self::coerce(static::columns()[$col] ?? 'string', $v);
    }

    private static function coerce(string $type, mixed $v): mixed
    {
        return match ($type) {
            'i32', 'i64' => (int) $v,
            'f64', 'decimal' => (float) $v,
            'bool' => (bool) $v,
            default => is_string($v) ? $v : (string) $v,
        };
    }

    protected function setCol(string $col, mixed $v): static
    {
        $this->dirty[$col] = $v;
        return $this;
    }

    protected function relation(string $name): mixed
    {
        return $this->rel[$name] ?? null;
    }

    /** compatibility-style getX()/getX($default): getters declared by the generated class win; this is the fallback. */
    public function __call(string $name, array $args): mixed
    {
        if (str_starts_with($name, 'get')) {
            $col = Names::snake(substr($name, 3));
            if (isset($this->rel[$col]) || array_key_exists($col, $this->rel)) {
                return $this->rel[$col] ?? ($args[0] ?? null);
            }
            if (!$this->has($col) && !isset(static::columns()[$col])) {
                if (array_key_exists(0, $args)) {
                    return $args[0];
                }
                throw new OrmException('COLUMN_UNKNOWN', static::entity() . ".$col");
            }
            $v = $this->col($col);
            return ($v === null || $v === '') && array_key_exists(0, $args) ? $args[0] : $v;
        }
        throw new \BadMethodCallException(static::class . "::$name");
    }

    // ---- ArrayAccess (snake_case) ----
    public function offsetExists(mixed $k): bool
    {
        return $this->has((string) $k) || array_key_exists((string) $k, $this->rel);
    }

    public function offsetGet(mixed $k): mixed
    {
        $k = (string) $k;
        if (array_key_exists($k, $this->rel)) {
            return $this->rel[$k];
        }
        return $this->col($k);
    }

    public function offsetSet(mixed $k, mixed $v): void
    {
        $this->setCol((string) $k, $v);
    }

    public function offsetUnset(mixed $k): void
    {
        unset($this->dirty[(string) $k]);
    }

    /** Deep array (compatibility toArray). */
    public function toArray(): array
    {
        $out = [];
        foreach ($this->idx as $name => $i) {
            $out[$name] = $this->col($name);
        }
        foreach ($this->dirty as $k => $v) {
            $out[$k] = $v;
        }
        foreach ($this->rel as $k => $v) {
            $out[$k] = $v instanceof Row ? $v->toArray() : ($v instanceof Collection ? $v->toArray() : $v);
        }
        return $out;
    }

    // ---- writes ----

    /** UPDATE the dirty columns; $optimistic compares updated_ts as read. */
    public function update(Db $ex, bool $optimistic = false): static
    {
        if (!$this->loaded) {
            throw new OrmException('INTERNAL', 'update on a row that was not loaded');
        }
        if ($this->dirty === []) {
            return $this;
        }
        $q = new Q(static::entity());
        foreach ($this->dirty as $col => $v) {
            $q->set($col, $v);
        }
        $pk = static::pk();
        $q->w()->pred($pk, 'eq', $this->col($pk));
        if ($optimistic) {
            $q->req->ir['optimistic'] = ['column' => 'updated_ts', 'p' => $q->req->p($this->col('updated_ts'))];
        }
        $q->req->ir['kind'] = 'update';
        $plan = Orm::transport()->plan($q->req->shape());
        $ex->write($plan['steps'][0], $q->req->params, false, $optimistic);
        $this->dirty = [];
        return $this;
    }

    public function delete(Db $ex): void
    {
        if (!$this->loaded) {
            throw new OrmException('INTERNAL', 'delete on a row that was not loaded');
        }
        $q = new Q(static::entity());
        $pk = static::pk();
        $q->w()->pred($pk, 'eq', $this->col($pk));
        $q->req->ir['kind'] = 'delete';
        $plan = Orm::transport()->plan($q->req->shape());
        $ex->write($plan['steps'][0], $q->req->params, false, false);
    }
}

/** Ordered map keyed by PK (or key_by). PHP arrays keep insertion order. */
final class Collection implements \ArrayAccess, \IteratorAggregate, \Countable
{
    /** @param array<int|string, Row> $items */
    public function __construct(private array $items = []) {}

    /** @param list<list<mixed>> $rows */
    public static function fromRows(array $rows, array $asm, string $rowClass): self
    {
        $c = new self();
        foreach ($rows as $vals) {
            $c->items[$vals[0]] = $rowClass::fromRow($vals, $asm);
        }
        return $c;
    }

    public function first(): ?Row
    {
        foreach ($this->items as $r) {
            return $r;
        }
        return null;
    }

    public function count(): int
    {
        return count($this->items);
    }

    public function getIterator(): \Iterator
    {
        return new \ArrayIterator($this->items);
    }

    public function keys(): array
    {
        return array_keys($this->items);
    }

    public function toArray(): array
    {
        return array_map(fn(Row $r) => $r->toArray(), $this->items);
    }

    public function offsetExists(mixed $k): bool
    {
        return isset($this->items[$k]);
    }

    public function offsetGet(mixed $k): ?Row
    {
        return $this->items[$k] ?? null;
    }

    public function offsetSet(mixed $k, mixed $v): void
    {
        $this->items[$k] = $v;
    }

    public function offsetUnset(mixed $k): void
    {
        unset($this->items[$k]);
    }
}

final class Page
{
    public function __construct(
        public readonly Collection $items,
        public readonly int $total,
        public readonly int $pages,
        public readonly int $current,
        public readonly int $per,
    ) {}
}

/** Maps entity names to generated row classes (filled by the generated bootstrap). */
final class Registry
{
    /** @var array<string, class-string<Row>> */
    private static array $rows = [];

    public static function register(string $entity, string $rowClass): void
    {
        self::$rows[$entity] = $rowClass;
    }

    /** @return class-string<Row> */
    public static function row(string $entity): string
    {
        return self::$rows[$entity] ?? throw new OrmException('ENTITY_UNKNOWN', $entity);
    }
}

final class Names
{
    public static function snake(string $s): string
    {
        return strtolower(preg_replace('/(?<!^)[A-Z]/', '_$0', $s));
    }
}
