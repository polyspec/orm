<?php
declare(strict_types=1);

namespace Orm;

/**
 * Base of every generated row class. Holds the positional values and a
 * reference to the assemble node's name→index map, so reads never copy.
 * Generated classes add typed getters/setters; ArrayAccess and getX($default)
 * are provided here for the PHP row API.
 */
abstract class Row implements \ArrayAccess
{
    use ConnectionBinding;
    /** @var list<mixed> */
    protected array $vals = [];
    /** @var array<string,int> */
    protected array $idx = [];
    /** @var array<string, mixed> joined / related rows by relation name */
    protected array $rel = [];
    /** @var array<string, mixed> columns changed through set* */
    protected array $dirty = [];
    /** @var array<string, list<string>> styles of dirty columns that need encoding on write */
    protected array $dirtyStyles = [];
    protected ?OrmException $error = null;
    /** @var array<string, mixed> columns merged from a flattened one-relation */
    protected array $extra = [];
    /** @var array<string, true> columns selected only for binding (drop_child_key): left out of toArray */
    protected array $hidden = [];
    /** @var list<string> loaded relations whose rows this row owns (plan children[].cascade): deleteCascade removes them first */
    protected array $cascade = [];
    protected bool $loaded = false;
    protected mixed $originalVersion = null;
    protected mixed $identity = null;

    abstract public static function entity(): string;
    abstract public static function pk(): string;
    protected static function versionColumn(): ?string { return null; }
    /** @return array<string,string> column => canonical type */
    abstract public static function columns(): array;

    /** A grouped getsCount() row carries COUNT(*) under this compatibility field. */
    public function getRowCount(mixed $default = 0): int
    {
        try {
            $v = $this->col('row_count');
        } catch (OrmException) {
            return (int) $default;
        }
        return $v === null ? (int) $default : (int) $v;
    }

    /** Grouped-count rows also expose selected/extra fields as properties. */
    public function __get(string $name): mixed
    {
        return $this->col($name);
    }

    /**
     * Maps a positional row onto the model, its joined children (same row) and
     * its relation children (rows of later steps, from $rows).
     * @param list<mixed> $vals @param array $asm assemble node with 'idx'
     */
    public static function fromRow(array $vals, array $asm, ?Rows $rows = null): static
    {
        $r = new static();
        if ($rows?->db !== null) { $r->bind($rows->db); }
        $r->vals = $vals;
        $r->idx = $asm['idx'];
        $r->hidden = $asm['hidden'] ?? [];
        $r->loaded = $r->has(static::pk());
        $r->identity = $r->col(static::pk());
        $version = static::versionColumn();
        if ($version !== null && isset($r->idx[$version])) { $r->originalVersion = $r->col($version); }
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                $ca = $ch['assemble'];
                $pkIdx = $ca['columns'][0]['index'];
                $r->rel[$ch['rel']] = $vals[$pkIdx] === null ? null : Registry::row($ca['entity'])::fromRow($vals, $ca, $rows);
                continue;
            }
            $related = $rows === null ? [] : $rows->related($ch, $vals);
            $ca = $rows === null ? [] : $rows->stepAssemble($ch);
            if (!empty($ch['cascade'])) {
                $r->cascade[] = $ch['rel'];
            }
            if ($ch['kind'] === 'one') {
                $child = $related === [] ? null : Registry::row($ca['entity'])::fromRow($related[0], $ca, $rows);
                $r->rel[$ch['rel']] = $child;
                if ($child !== null && ($ch['flatten'] ?? false)) {
                    foreach ($ca['columns'] as $c) {
                        if (empty($c['hidden']) && !isset($r->idx[$c['name']])) {
                            $r->extra[$c['name']] = $child->col($c['name']);
                        }
                    }
                }
            } else {
                $items = new Collection();
                $cls = Registry::row($ca['entity']);
                foreach ($related as $row) {
                    $items[Collection::keyOf($row[$ch['key_index']])] = $cls::fromRow($row, $ca, $rows);
                }
                $r->rel[$ch['rel']] = $items;
            }
        }
        return $r;
    }

    public function relLoaded(string $name): bool { return array_key_exists($name, $this->rel); }

    public function has(string $col): bool
    {
        return isset($this->idx[$col]) || array_key_exists($col, $this->dirty) || array_key_exists($col, $this->extra);
    }

    protected function col(string $col): mixed
    {
        if (array_key_exists($col, $this->dirty)) {
            return $this->dirty[$col];
        }
        if (!isset($this->idx[$col]) && array_key_exists($col, $this->extra)) {
            return $this->extra[$col];
        }
        if (!isset($this->idx[$col])) {
            if (isset(static::columns()[$col])) {
                return null; // declared but not selected (lazy) → null
            }
            throw new OrmException(Code::COLUMN_UNKNOWN, static::entity() . ".$col");
        }
        $v = $this->vals[$this->idx[$col]];
        return $v === null ? null : self::coerce(static::columns()[$col] ?? 'string', $v);
    }

    private static function coerce(string $type, mixed $v): mixed
    {
        return match ($type) {
            'styled' => $v,
            'i32', 'i64' => (int) $v,
            'f64', 'decimal' => (float) $v,
            'bool' => (bool) $v,
            default => is_string($v) ? $v : (string) $v,
        };
    }

    protected function setCol(string $col, mixed $v): static
    {
        if (!array_key_exists($col, $this->idx)) { $this->idx[$col] = count($this->vals); }
        $this->vals[$this->idx[$col]] = $v;
        $this->dirty[$col] = $v;
        return $this;
    }

    /** Records a styled column change; the value is kept decoded and encoded at write time. */
    protected function setStyled(string $col, mixed $v, array $styles): static
    {
        $this->setCol($col, $v);
        $this->dirtyStyles[$col] = $styles;
        try { Codec::encode($styles, $v); }
        catch (OrmException $e) { $this->error ??= $e; }
        return $this;
    }

    protected function relation(string $name): mixed
    {
        return $this->rel[$name] ?? null;
    }

    /**
     * Dynamic getX()/getX($default): getters declared by the generated class win; this is the fallback.
     * A relation is also reachable through get<Rel>Model() / get<Rel>Models().
     */
    public function __call(string $name, array $args): mixed
    {
        if (str_starts_with($name, 'get')) {
            $col = Names::snake(substr($name, 3));
            if (!array_key_exists($col, $this->rel) && preg_match('/^(.*)_models?$/', $col, $m) === 1 && array_key_exists($m[1], $this->rel)) {
                $col = $m[1];
            }
            if (isset($this->rel[$col]) || array_key_exists($col, $this->rel)) {
                return $this->rel[$col] ?? ($args[0] ?? null);
            }
            if (!$this->has($col) && !isset(static::columns()[$col])) {
                if (array_key_exists(0, $args)) {
                    return $args[0];
                }
                throw new OrmException(Code::COLUMN_UNKNOWN, static::entity() . ".$col");
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

    /** Deep array representation. */
    public function toArray(): array
    {
        $out = [];
        foreach ($this->idx as $name => $i) {
            if (!isset($this->hidden[$name])) {
                $out[$name] = $this->col($name);
            }
        }
        foreach ($this->extra as $k => $v) {
            $out[$k] = $v;
        }
        foreach ($this->dirty as $k => $v) {
            if (!isset($this->hidden[$k])) { $out[$k] = $v; }
        }
        foreach ($this->rel as $k => $v) {
            $out[$k] = $v instanceof Row ? $v->toArray() : ($v instanceof Collection ? $v->toArray() : $v);
        }
        return $out;
    }

    // ---- writes ----

    /** UPDATE the dirty columns by PK. */
    public function update(): void
    {
        $this->terminalArity(func_num_args());
        $this->doUpdate($this->terminalDb(), false);
    }

    /** UPDATE the dirty columns; fails with OPTIMISTIC_LOCK when updated_ts changed since the row was read. */
    protected function doUpdate(Db $ex, bool $optimistic): void
    {
        if ($this->error !== null) { throw $this->error; }
        if (!$this->loaded) {
            throw new OrmException(Code::CONFIG, 'update on a row that was not loaded');
        }
        if ($optimistic && $this->originalVersion === null) {
            throw new OrmException(Code::CONFIG, 'optimistic update requires a loaded version column');
        }
        if ($this->dirty === []) {
            return;
        }
        $q = new Q(static::entity());
        foreach ($this->dirty as $col => $v) {
            if (isset($this->dirtyStyles[$col])) {
                $q->setStyled($col, $v, $this->dirtyStyles[$col]);
            } else {
                $q->set($col, $v);
            }
        }
        $pk = static::pk();
        $q->w()->pred($pk, 'eq', $this->identity);
        if ($optimistic) {
            $q->optimistic(static::versionColumn(), $this->originalVersion);
        }
        $plan = Orm::transport()->planFor($q->req, 'update');
        $ex->write($plan['steps'][0], $q->req->params, false, $optimistic);
        $this->dirty = [];
        $this->dirtyStyles = [];
    }

    /** DELETE this row by PK; with $cascade the owned relations go first — see deleteCascade(). */
    public function delete(bool $cascade = false): void
    {
        if (func_num_args() > 1) { $this->terminalArity(func_num_args(), 1); }
        $this->deleteInner($this->terminalDb(), $cascade);
    }

    private function deleteInner(Db $ex, bool $cascade = false): void
    {
        if ($cascade) {
            $this->deleteCascadeInner($ex);
            return;
        }
        if (!$this->loaded) {
            throw new OrmException(Code::CONFIG, 'delete on a row that was not loaded');
        }
        $q = new Q(static::entity());
        $pk = static::pk();
        $q->w()->pred($pk, 'eq', $this->identity);
        $plan = Orm::transport()->planFor($q->req, 'delete');
        $ex->write($plan['steps'][0], $q->req->params, false, false);
    }

    /**
     * Deletes the rows this one owns — the loaded relations the plan flagged cascade (the related
     * rows hold this row's FK and noCascadeDelete was not set) — depth-first in collection order,
     * then this row, one DELETE … WHERE pk = ? per row. Parent-direction relations (the FK is on
     * this row) are never touched. A plain Db is wrapped in a transaction so a failure undoes the walk.
     */
    public function deleteCascade(): void
    {
        $this->terminalArity(func_num_args());
        $this->deleteCascadeInner($this->terminalDb());
    }

    private function deleteCascadeInner(Db $ex): void
    {
        if (!$ex instanceof Tx) {
            $ex->transaction(function (Tx $tx): void {
                $this->deleteCascadeInner($tx);
            });
            return;
        }
        foreach ($this->cascade as $name) {
            $owned = $this->rel[$name];
            foreach ($owned instanceof Collection ? $owned : ($owned === null ? [] : [$owned]) as $child) {
                $child->deleteCascadeInner($ex);
            }
        }
        $this->deleteInner($ex);
    }
}

/** Ordered map with distinct integer and string keys. */
final class Collection implements \ArrayAccess, \IteratorAggregate, \Countable
{
    /** @var array<string, array{key: int|string, value: Row}> */
    private array $items = [];

    /** @param array<int|string, Row> $items */
    public function __construct(array $items = [])
    {
        foreach ($items as $key => $row) { $this->put($key, $row); }
    }

    private static function identity(mixed $key): string
    {
        if (is_int($key)) { return 'i:' . $key; }
        if (is_string($key)) { return 's:' . $key; }
        throw new OrmException(Code::IR_INVALID, 'collection key must be an integer or string');
    }

    public function put(mixed $key, Row $value): void
    {
        $this->items[self::identity($key)] = ['key' => $key, 'value' => $value];
    }

    public function get(mixed $key): ?Row
    {
        return $this->items[self::identity($key)]['value'] ?? null;
    }

    /** Implicit column/expression keys keep integers and stringify other scalars. */
    public static function keyOf(mixed $key): int|string
    {
        if (is_int($key) || is_string($key)) { return $key; }
        return $key === null ? '' : (is_bool($key) ? ($key ? '1' : '0') : (string)$key);
    }

    public static function fromRows(Rows $rows, string $rowClass, ?\Closure $keyFn = null): self
    {
        $c = new self();
        foreach ($rows->data as $vals) {
            $r = $rowClass::fromRow($vals, $rows->asm, $rows);
            $key = $keyFn === null ? $vals[0] : $keyFn($r);
            // Expression groups can yield a scalar instead of an integer/text PK.
            // Match the native Key::of conversion; explicit key selectors stay typed.
            if ($keyFn === null) { $key = self::keyOf($key); }
            $c->put($key, $r);
        }
        return $c;
    }

    public function first(): ?Row
    {
        foreach ($this->items as $entry) { return $entry['value']; }
        return null;
    }

    public function count(): int { return count($this->items); }

    public function getIterator(): \Iterator
    {
        foreach ($this->items as $entry) { yield $entry['key'] => $entry['value']; }
    }

    /** @return list<int|string> */
    public function keys(): array { return array_column(array_values($this->items), 'key'); }

    /** @return list<array{key: int|string, value: Row}> */
    public function entries(): array { return array_values($this->items); }

    public function toArray(): array
    {
        $out = [];
        foreach ($this->items as $entry) {
            $key = $entry['key'];
            if (array_key_exists($key, $out)) {
                throw new OrmException(Code::IR_INVALID, 'array conversion loses key type; use entries');
            }
            $out[$key] = $entry['value']->toArray();
        }
        return $out;
    }

    public function offsetExists(mixed $k): bool { return isset($this->items[self::identity($k)]); }
    public function offsetGet(mixed $k): ?Row { return $this->get($k); }
    public function offsetSet(mixed $k, mixed $v): void { $this->put($k, $v); }
    public function offsetUnset(mixed $k): void { unset($this->items[self::identity($k)]); }
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

/** Result of a select plan: the main step's rows plus every relation step's rows grouped by match column. */
final class Rows
{
    public ?Db $db = null;
    /** @var array<int, array{data: list<list<mixed>>, byKey: array<int|string, list<int>>}> */
    public array $steps = [];

    /** @param list<list<mixed>> $data @param list<mixed> $params */
    public function __construct(public readonly array $plan, public readonly array $asm, public array $data, public readonly array $params) {}

    /**
     * Child rows of relation $ch for one parent row: empty when the parent's value is
     * null, when the step was skipped, or when the parent fails if_parent.
     * @return list<list<mixed>>
     */
    public function related(array $ch, array $parent): array
    {
        $sr = $this->steps[$ch['step']] ?? null;
        if ($sr === null) {
            return [];
        }
        $ifp = $this->plan['steps'][$ch['step']]['parent']['if_parent'] ?? null;
        if ($ifp !== null && !Db::sameScalar($parent[$ifp['index']], $this->params[$ifp['param']])) {
            return [];
        }
        $pv = $parent[$ch['parent_index'] ?? 0];
        if ($pv === null) {
            return [];
        }
        $out = [];
        foreach ($sr['byKey'][$pv] ?? [] as $i) {
            $out[] = $sr['data'][$i];
        }
        return $out;
    }

    public function stepAssemble(array $ch): array
    {
        return $this->plan['steps'][$ch['step']]['assemble'];
    }
}

/** Maps entity names to generated row classes and holds the generated code's schema hash (filled by the generated bootstrap). */
final class Registry
{
    /** @var array<string, class-string<Row>> */
    private static array $rows = [];
    private static string $hash = '';

    /** Called by the generated bootstrap with the schema_hash it was generated from. */
    public static function generated(string $schemaHash): void
    {
        self::$hash = $schemaHash;
    }

    /** The schema hash of the generated code; CONFIG when no bootstrap has been loaded. */
    public static function schemaHash(): string
    {
        return self::$hash !== '' ? self::$hash : throw new OrmException(Code::CONFIG, 'generated bootstrap.php not loaded');
    }

    public static function register(string $entity, string $rowClass): void
    {
        self::$rows[$entity] = $rowClass;
    }

    /** @return class-string<Row> */
    public static function row(string $entity): string
    {
        return self::$rows[$entity] ?? throw new OrmException(Code::ENTITY_UNKNOWN, $entity);
    }
}

final class Names
{
    public static function snake(string $s): string
    {
        return strtolower(preg_replace('/(?<!^)[A-Z]/', '_$0', $s));
    }

    public static function pascal(string $s): string
    {
        return str_replace('_', '', ucwords($s, '_'));
    }
}
