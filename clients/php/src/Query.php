<?php
declare(strict_types=1);

namespace Orm;

/**
 * Req: the value-free IR under construction plus its params and its signature —
 * every builder call that changes the IR appends a token to `sig`, so a repeated
 * shape is found in the per-request plan cache without encoding the IR again
 * (the signature determines the IR; the IR bytes remain the cross-worker key).
 * Q / W: untyped cores of the generated query and where builders.
 */
final class Req
{
    public array $ir;
    /** @var list<mixed> */
    public array $params = [];
    public ?OrmException $error = null;
    /** shape signature: entity, then one token per IR mutation in call order */
    public string $sig;

    public function __construct(string $entity)
    {
        $this->ir = [
            'ir_version' => 1,
            'schema_hash' => Orm::config()->schemaHash(),
            'kind' => '',
            'entity' => $entity,
        ];
        $this->sig = $entity;
    }

    public function p(mixed $v): int
    {
        $this->params[] = $v;
        return count($this->params) - 1;
    }

    /** Closes the group opened by the last W::group()/nav() (the generated and()/nav closures call it). */
    public function end(): void
    {
        $this->sig .= ')';
    }

    /** Length-prefixed user text for the signature (fragments, aliases, raw SQL). */
    public static function str(string $s): string
    {
        return strlen($s) . ':' . $s;
    }

    /** Merge a child query into this request: append its params, shift its indices, append its signature. */
    public function attach(Req $child, string $token): array
    {
        $this->error ??= $child->error;
        $off = count($this->params);
        foreach ($child->params as $v) {
            $this->params[] = $v;
        }
        $q = self::copyTree($child->ir);
        unset($q['ir_version'], $q['schema_hash'], $q['kind'], $q['n_params'],
            $q['set'], $q['on_duplicate'], $q['optimistic'], $q['raw'], $q['agg'], $q['debug']);
        self::shiftQuery($q, $off);
        $this->sig .= $token . '{' . $child->sig . '}';
        return $q;
    }

    private static function shiftQuery(array &$q, int $off): void
    {
        if (isset($q['scope_p'])) {
            $q['scope_p'] += $off;
        }
        foreach (['on', 'where', 'having'] as $k) {
            if (isset($q[$k])) {
                self::shiftGroup($q[$k], $off);
            }
        }
        foreach (['joins', 'relations'] as $k) {
            if (isset($q[$k])) {
                foreach ($q[$k] as &$j) {
                    self::shiftQuery($j['query'], $off);
                }
            }
        }
        if (isset($q['if_parent'])) {
            $q['if_parent']['p'] += $off;
        }
    }

    private static function copyTree(array $tree): array
    {
        $copy = [];
        foreach ($tree as $key => $value) {
            $copy[$key] = is_array($value) ? self::copyTree($value) : $value;
        }
        return $copy;
    }

    private static function shiftGroup(array &$g, int $off): void
    {
        foreach ($g['items'] as &$it) {
            if (isset($it['pred'])) {
                if (isset($it['pred']['p'])) {
                    $it['pred']['p'] += $off;
                }
                if (isset($it['pred']['ps'])) {
                    foreach ($it['pred']['ps'] as &$i) {
                        $i += $off;
                    }
                }
            } elseif (isset($it['group'])) {
                self::shiftGroup($it['group'], $off);
            } elseif (isset($it['nav'])) {
                self::shiftGroup($it['nav']['group'], $off);
            }
        }
    }

    /** The IR with kind and n_params set, ready to hash/compile. */
    public function shape(string $kind): array
    {
        $ir = $this->ir;
        $ir['kind'] = $kind;
        $ir['n_params'] = count($this->params);
        return $ir;
    }
}

/** Edits one group: root where, a nested group, an ON group, or a nav group. */
class W
{
    private bool $pendingOr = false;

    /** @param array $g reference to the group array */
    public function __construct(public readonly Req $req, public array &$g) {}

    private function conn(): array
    {
        if ($this->pendingOr) {
            $this->pendingOr = false;
            $this->req->sig .= '|o';
            return ['conn' => 'or'];
        }
        return [];
    }

    public function orConn(): void
    {
        $this->pendingOr = true;
    }

    public function pred(string $col, string $op, mixed $v): void
    {
        $this->predAt($col, $op, $this->req->p($v));
    }

    /** A predicate over an already-registered param (save reuses the PK assignment's slot as its where). */
    public function predAt(string $col, string $op, int $p): void
    {
        if ($this->pendingOr) {
            $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op, 'p' => $p]];
        } else {
            $this->g['items'][] = ['pred' => ['column' => $col, 'op' => $op, 'p' => $p]];
        }
        $this->req->sig .= "|p$col\x1f$op\x1f$p";
    }

    /** @param list<mixed> $vs */
    public function predList(string $col, string $op, array $vs): void
    {
        $vs = self::padIn($op, $vs);
        $ps = [];
        foreach ($vs as $v) {
            $ps[] = $this->req->p($v);
        }
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op, 'ps' => $ps]];
        $this->req->sig .= "|l$col\x1f$op\x1f" . implode(',', $ps);
    }

    /**
     * Rounds an IN list up to a power of two by repeating its last value. A repeated
     * value cannot change what IN or NOT IN match, and it keeps the number of distinct
     * statements logarithmic in the list length instead of linear: without it every
     * length mints its own plan and its own server-side prepared statement (MySQL's
     * max_prepared_stmt_count is 16382 by default). Relation IN lists are bucketed the
     * same way when the executor expands them.
     */
    private static function padIn(string $op, array $vs): array
    {
        if (($op !== 'in' && $op !== 'not_in') || count($vs) < 2) {
            return $vs;
        }
        $n = 1;
        while ($n < count($vs)) {
            $n <<= 1;
        }
        return array_pad($vs, $n, $vs[count($vs) - 1]);
    }

    public function predNull(string $col, string $op): void
    {
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op]];
        $this->req->sig .= "|z$col\x1f$op";
    }

    public function predCol(string $col, string $op, ColRef $ref): void
    {
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op, 'ref' => ['path' => $ref->path, 'column' => $ref->column]]];
        $this->req->sig .= "|c$col\x1f$op\x1f" . Req::str($ref->path) . $ref->column;
    }

    /** @param list<string> $cols */
    public function match(array $cols, bool $boolean, string $v): void
    {
        $p = $this->req->p($v);
        $this->g['items'][] = ['pred' => $this->conn() + ['op' => $boolean ? 'match_boolean' : 'match', 'match' => $cols, 'p' => $p]];
        $this->req->sig .= '|m' . ($boolean ? 'b' : 'n') . implode(',', $cols) . "\x1f$p";
    }

    public function expr(string $frag, array $binds): void
    {
        $ps = [];
        foreach ($binds as $v) {
            $ps[] = $this->req->p($v);
        }
        $this->g['items'][] = ['pred' => $this->conn() + ['expr' => $frag, 'ps' => $ps]];
        $this->req->sig .= '|e' . Req::str($frag) . implode(',', $ps);
    }

    /** Opens a parenthesised group; returns the W over it. The caller ends it with $req->end(). */
    public function group(): W
    {
        $this->g['items'][] = ['group' => $this->conn() + ['items' => []]];
        $this->req->sig .= '|(';
        return new W($this->req, $this->g['items'][count($this->g['items']) - 1]['group']);
    }

    /** Descends into a joined relation; returns the W over the nav group. The caller ends it with $req->end(). */
    public function nav(string $rel): W
    {
        $this->g['items'][] = ['nav' => $this->conn() + ['rel' => $rel, 'group' => ['items' => []]]];
        $this->req->sig .= "|n$rel(";
        return new W($this->req, $this->g['items'][count($this->g['items']) - 1]['nav']['group']);
    }
}

/** Untyped core of a generated query builder (root, join child or relation child). */
class Q
{
    use ConnectionBinding;
    public Req $req;
    /** @var array reference to the query node this builder edits */
    public array $node;
    private bool $pendingOr = false;
    /** the group the next predicate lands in */
    private ?W $rootW = null;
    /** keyByFn: client-side keying of the root collection (relations key by keyBy<Col>) */
    public ?\Closure $keyFn = null;

    public function __construct(string $entity)
    {
        $this->req = new Req($entity);
        $this->node = &$this->req->ir;
    }

    public function keyByFn(\Closure $fn): static
    {
        $this->keyFn = $fn;
        return $this;
    }

    public function scopeValue(mixed $value): void
    {
        $p = $this->req->p($value);
        $this->node['scope_p'] = $p;
        $this->req->sig .= "|scope\x1f$p";
    }

    /** W over the root where group, carrying the pending connector. */
    public function w(): W
    {
        if ($this->rootW === null) {
            $this->node['where'] ??= ['items' => []];
            $this->rootW = new W($this->req, $this->node['where']);
        }
        if ($this->pendingOr) {
            $this->rootW->orConn();
            $this->pendingOr = false;
        }
        return $this->rootW;
    }

    public function onW(): W
    {
        $this->node['on'] ??= ['items' => []];
        $this->req->sig .= '|O';
        return new W($this->req, $this->node['on']);
    }

    /** W over the root having group (root only; the engine requires group_by). */
    public function havingW(): W
    {
        $this->node['having'] ??= ['items' => []];
        $this->req->sig .= '|H';
        return new W($this->req, $this->node['having']);
    }

    /** kind raw: the hand-written statement; `{table}` is this entity's table, each `?` bound from $binds in order. */
    public function setRaw(string $sql, array $binds): void
    {
        $ps = [];
        foreach ($binds as $v) {
            $ps[] = $this->req->p($v);
        }
        $this->req->ir['raw'] = ['sql' => $sql, 'ps' => $ps];
        $this->req->sig .= '|raw' . Req::str($sql) . implode(',', $ps);
    }

    public function orConn(): void
    {
        $this->pendingOr = true;
    }

    public function attachJoin(string $rel, string $kind, Q $child): void
    {
        $this->node['joins'][] = ['rel' => $rel, 'kind' => $kind, 'query' => $this->req->attach($child->req, "|J$rel\x1f$kind")];
    }

    public function attachRelation(string $rel, Q $child): void
    {
        $this->node['relations'][] = ['rel' => $rel, 'query' => $this->req->attach($child->req, "|R$rel")];
    }

    /** Stores the parent/child key pair selected on this child query. */
    public function setLink(string $left, string $right): void
    {
        $this->req->sig .= "|L$left\x1f$right";
    }

    // ---- columns ----

    public function colMode(string $mode): void
    {
        $this->node['columns']['mode'] = $mode;
        $this->req->sig .= "|cm$mode";
    }

    public function colAdd(string $col): void
    {
        $this->node['columns']['add'][] = $col;
        $this->req->sig .= "|ca$col";
    }

    public function colRemove(string $col): void
    {
        $this->node['columns']['remove'][] = $col;
        $this->req->sig .= "|cr$col";
    }

    public function colAs(string $name, string $col): void
    {
        $this->node['columns']['as'][$name] = $col;
        $this->req->sig .= '|cs' . Req::str($name) . $col;
    }

    public function colExpr(string $name, string $frag): void
    {
        $this->node['columns']['expr'][$name] = $frag;
        $this->req->sig .= '|ce' . Req::str($name) . Req::str($frag);
    }

    // ---- order, group, limit, flags ----

    public function order(string $col, bool $desc): void
    {
        $this->node['order'][] = ['column' => $col, 'desc' => $desc];
        $this->req->sig .= '|>' . ($desc ? 'd' : 'a') . $col;
    }

    public function orderExpr(string $frag, bool $desc): void
    {
        $this->node['order'][] = ['expr' => $frag, 'desc' => $desc];
        $this->req->sig .= '|>x' . ($desc ? 'd' : 'a') . Req::str($frag);
    }

    public function lock(string $mode): void { $this->node['lock'] = $mode; $this->req->sig .= "|:lock\x1f$mode"; }

    public function groupBy(string $col, ?string $alias = null): void
    {
        if ($alias !== null) {
            $this->groupExpr($col, $alias);
            return;
        }
        $this->node['group_by'][] = $col;
        $this->req->sig .= "|g$col";
    }

    public function groupExpr(string $expr, string $alias): void
    {
        $this->node['group_by_expr'][] = ['expr' => $expr, 'as' => $alias];
        $this->req->sig .= '|gx' . Req::str($expr) . Req::str($alias);
    }

    public function setLimit(int $offset, int $count): void
    {
        $this->node['limit'] = ['offset' => $offset, 'count' => $count];
        $this->req->sig .= "|L$offset,$count";
    }

    /** Configures a validated root keyset boundary and its positive page size. */
    public function keyset(string $direction, string $cursor, int $per, array $primaryKeys): void
    {
        if ($direction !== 'after' && $direction !== 'before') throw new OrmException(Code::CURSOR_INVALID, 'keyset direction must be after or before');
        if ($per < 1) throw new OrmException(Code::IR_INVALID, 'keyset limit must be positive');
        $this->node['order'] ??= [];
        if ($this->node['order'] === []) foreach ($primaryKeys as $column) $this->order($column, false);
        $seen = [];
        foreach ($this->node['order'] as $item) {
            if (empty($item['column']) || !empty($item['expr'])) throw new OrmException(Code::CURSOR_INVALID, 'keyset order must use table columns');
            if (isset($seen[$item['column']])) throw new OrmException(Code::CURSOR_INVALID, 'keyset order contains duplicate column ' . $item['column']);
            $seen[$item['column']] = true;
        }
        foreach ($primaryKeys as $column) if (!isset($seen[$column])) { $this->order($column, false); $seen[$column] = true; }
        $this->setLimit(0, $per);
        if ($cursor === '') { unset($this->node['keyset']); return; }
        if ($direction !== 'after' && $direction !== 'before') throw new OrmException(Code::CURSOR_INVALID, 'keyset direction must be after or before');
        $decoded = KeysetCursor::decode($cursor);
        $normalize = static fn(array $item): array => ['column' => $item['column'] ?? '', 'expr' => $item['expr'] ?? '', 'desc' => (bool)($item['desc'] ?? false)];
        if (array_map($normalize, $decoded['order']) !== array_map($normalize, $this->node['order'])) throw new OrmException(Code::CURSOR_INVALID, 'cursor order does not match query order');
        $indexes = [];
        foreach ($decoded['values'] as $value) $indexes[] = $this->req->p($value);
        $this->node['keyset'] = ['direction' => $direction, 'values' => $indexes];
        $this->req->sig .= '|keyset' . $direction . implode(',', $indexes);
    }

    /** A scalar option of this node: key_by, distinct, force_index, flatten, limit_per_parent, drop_child_key, no_cascade_delete. */
    public function opt(string $key, int|string|bool $v): void
    {
        $this->node[$key] = $v;
        $this->req->sig .= "|:$key\x1f$v";
    }

    // ---- assignments: set[] (insert/update) and on_duplicate[] (insert) share one shape ----

    private function assignValue(string $col, mixed $v, string $tok): array
    {
        if ($v === null) {
            $this->req->sig .= "|$tok$col\x1fN";
            return ['column' => $col, 'null' => true];
        }
        $p = $this->req->p($v);
        $this->req->sig .= "|$tok$col\x1f$p";
        return ['column' => $col, 'p' => $p];
    }

    private function assignExpr(string $col, string $frag, array $binds, string $tok): array
    {
        $ps = [];
        foreach ($binds as $v) {
            $ps[] = $this->req->p($v);
        }
        $this->req->sig .= "|$tok$col\x1f" . Req::str($frag) . implode(',', $ps);
        return ['column' => $col, 'expr' => $frag, 'ps' => $ps];
    }

    /** Encodes $v with the column's styles (docs/codec.md) before binding it. */
    public function setStyled(string $col, mixed $v, array $styles): void
    {
        try { $this->set($col, Codec::encode($styles, $v)); }
        catch (OrmException $e) { $this->req->error ??= $e; }
    }

    public function set(string $col, mixed $v): void
    {
        $this->req->ir['set'][] = $this->assignValue($col, $v, 's');
    }

    public function setExpr(string $col, string $frag, array $binds): void
    {
        $this->req->ir['set'][] = $this->assignExpr($col, $frag, $binds, 'sx');
    }

    public function plus(string $col, int|float $v): void
    {
        $p = $this->req->p($v);
        $this->req->ir['set'][] = ['column' => $col, 'plus_p' => $p];
        $this->req->sig .= "|s+$col\x1f$p";
    }

    public function minus(string $col, int|float $v): void
    {
        $p = $this->req->p($v);
        $this->req->ir['set'][] = ['column' => $col, 'minus_p' => $p];
        $this->req->sig .= "|s-$col\x1f$p";
    }

    public function onDuplicateStyled(string $col, mixed $v, array $styles): void
    {
        try { $this->onDuplicate($col, Codec::encode($styles, $v)); }
        catch (OrmException $e) { $this->req->error ??= $e; }
    }

    public function onDuplicate(string $col, mixed $v): void
    {
        $this->req->ir['on_duplicate'][] = $this->assignValue($col, $v, 'd');
    }

    public function onDuplicateExpr(string $col, string $frag, array $binds): void
    {
        $this->req->ir['on_duplicate'][] = $this->assignExpr($col, $frag, $binds, 'dx');
    }

    public function onDuplicatePlus(string $col, int|float $v): void
    {
        $p = $this->req->p($v);
        $this->req->ir['on_duplicate'][] = ['column' => $col, 'plus_p' => $p];
        $this->req->sig .= "|d+$col\x1f$p";
    }

    public function onDuplicateMinus(string $col, int|float $v): void
    {
        $p = $this->req->p($v);
        $this->req->ir['on_duplicate'][] = ['column' => $col, 'minus_p' => $p];
        $this->req->sig .= "|d-$col\x1f$p";
    }

    /**
     * Copies the set[] assignments made so far into on_duplicate, except $skip (the PK/auto
     * columns the engine refuses). Each value is registered again as its own param, exactly as
     * calling the onDuplicateSet* methods would; set* calls made after this one are not mirrored.
     * @param list<string> $skip
     */
    public function onDuplicateAll(array $skip): void
    {
        foreach ($this->req->ir['set'] ?? [] as $a) {
            if (in_array($a['column'], $skip, true)) {
                continue;
            }
            foreach (['p', 'plus_p', 'minus_p'] as $k) {
                if (isset($a[$k])) {
                    $a[$k] = $this->req->p($this->req->params[$a[$k]]);
                }
            }
            if (isset($a['ps'])) {
                $a['ps'] = array_map(fn(int $i) => $this->req->p($this->req->params[$i]), $a['ps']);
            }
            $this->req->ir['on_duplicate'][] = $a;
        }
        $this->req->sig .= '|dall';
    }

    public function ifParent(string $col, mixed $v): void
    {
        $p = $this->req->p($v);
        $this->node['if_parent'] = ['column' => $col, 'p' => $p];
        $this->req->sig .= "|if$col\x1f$p";
    }

    /** updateOptimistic: the UPDATE also matches $col = its value as read. */
    public function optimistic(string $col, mixed $v): void
    {
        $p = $this->req->p($v);
        $this->req->ir['optimistic'] = ['column' => $col, 'p' => $p];
        $this->req->sig .= "|opt$col\x1f$p";
    }

    // ---- terminals (generated classes wrap these with typed results) ----

    protected function plan(Db $ex, string $kind): array
    {
        return $ex->db()->planFor($this->req, $kind);
    }

    /** Runs the select plan (main step + relation steps). */
    public function runQuery(Db $ex, string $kind): Rows
    {
        return $ex->runPlan($this->plan($ex, $kind), $this->req->params);
    }

    public function runScalar(Db $ex, string $kind, ?string $agg = null): mixed
    {
        if ($agg !== null) {
            $this->req->ir['agg'] = $agg;
            $this->req->sig .= "|agg$agg";
        }
        $plan = $this->plan($ex, $kind);
        return $ex->scalar($plan['steps'][0], $this->req->params);
    }

    /** @return array{0: Rows, 1: int} rows (with relations) and total */
    public function runPaginate(Db $ex, int $page, int $per): array
    {
        $page = max(1, $page);
        $this->setLimit(($page - 1) * $per, $per);
        $plan = $this->plan($ex, 'paginate');
        $rows = $ex->runPlan($plan, $this->req->params);
        $total = 0;
        foreach ($plan['steps'] as $st) {
            if ($st['role'] === 'count') {
                $total = (int) $ex->scalar($st, $this->req->params);
            }
        }
        return [$rows, $total];
    }

    /** @return int|string|null last insert id */
    public function runInsert(Db $ex): int|string|null
    {
        $plan = $this->plan($ex, 'insert');
        [$id] = $ex->write($plan['steps'][0], $this->req->params, true, false);
        return $id;
    }

    /** @param non-empty-list<string> $keys @return list<mixed> */
    public function assignedKeyValues(array $keys): array
    {
        $values = [];
        foreach ($keys as $key) {
            $assignment = null;
            foreach ($this->req->ir['set'] ?? [] as $candidate) { if ($candidate['column'] === $key) { $assignment = $candidate; break; } }
            if ($assignment === null) { throw new OrmException(Code::IR_INVALID, 'insert requires every non-auto primary-key column'); }
            if (!isset($assignment['p'])) { throw new OrmException(Code::IR_INVALID, 'insert primary-key assignments must use values'); }
            $values[] = $this->req->params[$assignment['p']];
        }
        return $values;
    }

    /** UPDATE set[] / DELETE by the query's where (the engine rejects a missing where). @return int affected rows */
    public function runWrite(Db $ex, string $kind): int
    {
        $plan = $this->plan($ex, $kind);
        [, $affected] = $ex->write($plan['steps'][0], $this->req->params, false, false);
        return $affected;
    }

    /**
     * save: when the draft sets the PK, UPDATE the other set[] columns WHERE pk = that value
     * (the assignment's param slot becomes the where); otherwise INSERT.
     * @return array{0: bool, 1: mixed} whether it was an update, and the key to re-read by (the PK value, or the insert id)
     */
    public function runSave(Db $ex, array $keys): array
    {
        if ($keys === []) { throw new OrmException(Code::IR_INVALID, 'save requires at least one primary-key column'); }
        $assignments = $this->req->ir['set'] ?? [];
        $indexes = [];
        foreach ($keys as $key) {
            $index = null;
            foreach ($assignments as $i => $assignment) { if ($assignment['column'] === $key) { $index = $i; break; } }
            $indexes[] = $index;
        }
        $present = count(array_filter($indexes, static fn($index) => $index !== null));
        if ($present === 0) { return [false, [$this->runInsert($ex)]]; }
        if ($present !== count($keys)) { throw new OrmException(Code::IR_INVALID, 'save requires every primary-key column or none'); }
        $values = [];
        foreach ($indexes as $i => $index) {
            $assignment = $assignments[$index];
            if (!isset($assignment['p'])) { throw new OrmException(Code::IR_INVALID, 'save primary-key assignments must use values'); }
            $values[] = $this->req->params[$assignment['p']];
            $this->w()->predAt($keys[$i], 'eq', $assignment['p']);
        }
        $remove = array_flip($indexes);
        $this->req->ir['set'] = array_values(array_filter($assignments, static fn($_, $i) => !isset($remove[$i]), ARRAY_FILTER_USE_BOTH));
        $this->req->sig .= '|save:' . implode(',', $keys);
        $this->runWrite($ex, 'update');
        return [true, $values];
    }

    /** Runs the raw() statement (step role raw, no assemble): rows keyed by column name, values as the driver gives them. @return list<array<string, mixed>> */
    public function runRaw(Db $ex): array
    {
        return $ex->rows($this->plan($ex, 'raw')['steps'][0], $this->req->params);
    }

    /** The main step's SQL and resolved binds without executing (the plan is compiled and cached as usual). */
    public function runSql(Db $ex): array
    {
        return $ex->sqlOf($this->plan($ex, 'all')['steps'][0], $this->req->params);
    }
}

/**
 * A column of another entity in the same statement, for column-to-column predicates:
 * path '' is the parent (inside on()/where() of a join child) or the root; at('service') walks joins.
 */
final class ColRef
{
    public function __construct(public readonly string $column, public readonly string $path = '') {}

    public function at(string $path): self
    {
        return new self($this->column, $path);
    }
}
