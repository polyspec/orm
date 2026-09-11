<?php
declare(strict_types=1);

namespace Orm;

/**
 * Req: the value-free IR under construction plus its params.
 * Q / W: untyped cores of the generated query and where builders.
 */
final class Req
{
    public array $ir;
    /** @var list<mixed> */
    public array $params = [];

    public function __construct(string $kind, string $entity)
    {
        $this->ir = [
            'ir_version' => 1,
            'schema_hash' => Orm::config()->schemaHash(),
            'kind' => $kind,
            'entity' => $entity,
        ];
    }

    public function p(mixed $v): int
    {
        $this->params[] = $v;
        return count($this->params) - 1;
    }

    /** Merge a child query into this request: append its params, shift its indices. */
    public function attach(Req $child): array
    {
        $off = count($this->params);
        foreach ($child->params as $v) {
            $this->params[] = $v;
        }
        $q = $child->ir;
        unset($q['ir_version'], $q['schema_hash'], $q['kind']);
        self::shiftQuery($q, $off);
        return $q;
    }

    private static function shiftQuery(array &$q, int $off): void
    {
        foreach (['on', 'where'] as $k) {
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

    /** The IR with n_params set, ready to hash/compile. */
    public function shape(): array
    {
        $ir = $this->ir;
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
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op, 'p' => $p]];
    }

    /** @param list<mixed> $vs */
    public function predList(string $col, string $op, array $vs): void
    {
        $ps = [];
        foreach ($vs as $v) {
            $ps[] = $this->req->p($v);
        }
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op, 'ps' => $ps]];
    }

    public function predNull(string $col, string $op): void
    {
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op]];
    }

    public function predCol(string $col, string $op, ColRef $ref): void
    {
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op, 'ref' => ['path' => $ref->path, 'column' => $ref->column]]];
    }

    /** @param list<string> $cols */
    public function match(array $cols, bool $boolean, string $v): void
    {
        $this->g['items'][] = ['pred' => $this->conn() + ['op' => $boolean ? 'match_boolean' : 'match', 'match' => $cols, 'p' => $this->req->p($v)]];
    }

    public function expr(string $frag, array $binds): void
    {
        $ps = [];
        foreach ($binds as $v) {
            $ps[] = $this->req->p($v);
        }
        $this->g['items'][] = ['pred' => $this->conn() + ['expr' => $frag, 'ps' => $ps]];
    }

    /** Opens a parenthesised group; returns a reference to it for a nested W. */
    public function &group(): array
    {
        $this->g['items'][] = ['group' => $this->conn() + ['items' => []]];
        return $this->g['items'][count($this->g['items']) - 1]['group'];
    }

    /** Descends into a joined relation; returns a reference to the nav group. */
    public function &nav(string $rel): array
    {
        $this->g['items'][] = ['nav' => $this->conn() + ['rel' => $rel, 'group' => ['items' => []]]];
        return $this->g['items'][count($this->g['items']) - 1]['nav']['group'];
    }
}

/** Untyped core of a generated query builder (root, join child or relation child). */
class Q
{
    public Req $req;
    /** @var array reference to the query node this builder edits */
    public array $node;
    private bool $pendingOr = false;
    /** keyByFn: client-side keying of the root collection (relations key by keyBy<Col>) */
    public ?\Closure $keyFn = null;

    public function __construct(string $entity)
    {
        $this->req = new Req('all', $entity);
        $this->node = &$this->req->ir;
    }

    public function keyByFn(\Closure $fn): static
    {
        $this->keyFn = $fn;
        return $this;
    }

    /** W over the root where group, carrying the pending connector. */
    public function w(): W
    {
        $this->node['where'] ??= ['items' => []];
        $w = new W($this->req, $this->node['where']);
        if ($this->pendingOr) {
            $w->orConn();
            $this->pendingOr = false;
        }
        return $w;
    }

    public function onW(): W
    {
        $this->node['on'] ??= ['items' => []];
        return new W($this->req, $this->node['on']);
    }

    /** W over the root having group (root only; the engine requires group_by). */
    public function havingW(): W
    {
        $this->node['having'] ??= ['items' => []];
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
    }

    public function orConn(): void
    {
        $this->pendingOr = true;
    }

    public function join(string $rel, string $kind, Q $child): void
    {
        $this->node['joins'][] = ['rel' => $rel, 'kind' => $kind, 'query' => $this->req->attach($child->req)];
    }

    public function relation(string $rel, Q $child): void
    {
        $this->node['relations'][] = ['rel' => $rel, 'query' => $this->req->attach($child->req)];
    }

    public function &columns(): array
    {
        $this->node['columns'] ??= [];
        return $this->node['columns'];
    }

    public function order(string $col, bool $desc): void
    {
        $this->node['order'][] = ['column' => $col, 'desc' => $desc];
    }

    public function orderExpr(string $frag, bool $desc): void
    {
        $this->node['order'][] = ['expr' => $frag, 'desc' => $desc];
    }

    // ---- assignments: set[] (insert/update) and on_duplicate[] (insert) share one shape ----

    private function assignValue(string $col, mixed $v): array
    {
        return $v === null ? ['column' => $col, 'null' => true] : ['column' => $col, 'p' => $this->req->p($v)];
    }

    private function assignExpr(string $col, string $frag, array $binds): array
    {
        $ps = [];
        foreach ($binds as $v) {
            $ps[] = $this->req->p($v);
        }
        return ['column' => $col, 'expr' => $frag, 'ps' => $ps];
    }

    /** Encodes $v with the column's styles (docs/codec.md) before binding it. */
    public function setStyled(string $col, mixed $v, array $styles): void
    {
        $this->set($col, Codec::encode($styles, $v));
    }

    public function set(string $col, mixed $v): void
    {
        $this->req->ir['set'][] = $this->assignValue($col, $v);
    }

    public function setExpr(string $col, string $frag, array $binds): void
    {
        $this->req->ir['set'][] = $this->assignExpr($col, $frag, $binds);
    }

    public function plus(string $col, int|float $v): void
    {
        $this->req->ir['set'][] = ['column' => $col, 'plus_p' => $this->req->p($v)];
    }

    public function minus(string $col, int|float $v): void
    {
        $this->req->ir['set'][] = ['column' => $col, 'minus_p' => $this->req->p($v)];
    }

    public function onDuplicateStyled(string $col, mixed $v, array $styles): void
    {
        $this->onDuplicate($col, Codec::encode($styles, $v));
    }

    public function onDuplicate(string $col, mixed $v): void
    {
        $this->req->ir['on_duplicate'][] = $this->assignValue($col, $v);
    }

    public function onDuplicateExpr(string $col, string $frag, array $binds): void
    {
        $this->req->ir['on_duplicate'][] = $this->assignExpr($col, $frag, $binds);
    }

    public function onDuplicatePlus(string $col, int|float $v): void
    {
        $this->req->ir['on_duplicate'][] = ['column' => $col, 'plus_p' => $this->req->p($v)];
    }

    public function onDuplicateMinus(string $col, int|float $v): void
    {
        $this->req->ir['on_duplicate'][] = ['column' => $col, 'minus_p' => $this->req->p($v)];
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
    }

    public function ifParent(string $col, mixed $v): void
    {
        $this->node['if_parent'] = ['column' => $col, 'p' => $this->req->p($v)];
    }

    // ---- terminals (generated classes wrap these with typed results) ----

    protected function plan(string $kind): array
    {
        $this->req->ir['kind'] = $kind;
        return Orm::transport()->plan($this->req->shape());
    }

    /** Runs the select plan (main step + relation steps). */
    public function runQuery(Db $ex, string $kind): Rows
    {
        return $ex->runPlan($this->plan($kind), $this->req->params);
    }

    public function runScalar(Db $ex, string $kind, ?string $agg = null): mixed
    {
        if ($agg !== null) {
            $this->req->ir['agg'] = $agg;
        }
        $plan = $this->plan($kind);
        return $ex->scalar($plan['steps'][0], $this->req->params);
    }

    /** @return array{0: Rows, 1: int} rows (with relations) and total */
    public function runPaginate(Db $ex, int $page, int $per): array
    {
        $page = max(1, $page);
        $this->node['limit'] = ['offset' => ($page - 1) * $per, 'count' => $per];
        $plan = $this->plan('paginate');
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
        $plan = $this->plan('insert');
        [$id] = $ex->write($plan['steps'][0], $this->req->params, true, false);
        return $id;
    }

    /** UPDATE set[] / DELETE by the query's where (the engine rejects a missing where). @return int affected rows */
    public function runWrite(Db $ex, string $kind): int
    {
        $plan = $this->plan($kind);
        [, $affected] = $ex->write($plan['steps'][0], $this->req->params, false, false);
        return $affected;
    }

    /**
     * save: when the draft sets the PK, UPDATE the other set[] columns WHERE pk = that value
     * (the assignment's param slot becomes the where); otherwise INSERT.
     * @return array{0: bool, 1: mixed} whether it was an update, and the key to re-read by (the PK value, or the insert id)
     */
    public function runSave(Db $ex, string $pk): array
    {
        foreach ($this->req->ir['set'] ?? [] as $i => $a) {
            if ($a['column'] !== $pk) {
                continue;
            }
            if (!isset($a['p'])) {
                throw new OrmException('IR_INVALID', "save: $pk must be set to a value");
            }
            unset($this->req->ir['set'][$i]);
            $this->req->ir['set'] = array_values($this->req->ir['set']);
            $this->w()->predAt($pk, 'eq', $a['p']);
            $this->runWrite($ex, 'update');
            return [true, $this->req->params[$a['p']]];
        }
        return [false, $this->runInsert($ex)];
    }

    /** Runs the raw() statement (step role raw, no assemble): rows keyed by column name, values as the driver gives them. @return list<array<string, mixed>> */
    public function runRaw(Db $ex): array
    {
        return $ex->rows($this->plan('raw')['steps'][0], $this->req->params);
    }

    /** The main step's SQL and resolved binds without executing (the plan is compiled and cached as usual). */
    public function runSql(Db $ex): array
    {
        return $ex->sqlOf($this->plan('all')['steps'][0], $this->req->params);
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

