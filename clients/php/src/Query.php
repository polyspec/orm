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
        $this->g['items'][] = ['pred' => $this->conn() + ['column' => $col, 'op' => $op, 'p' => $this->req->p($v)]];
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

    public function __construct(string $entity)
    {
        $this->req = new Req('all', $entity);
        $this->node = &$this->req->ir;
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

    public function set(string $col, mixed $v): void
    {
        if ($v === null) {
            $this->req->ir['set'][] = ['column' => $col, 'null' => true];
            return;
        }
        $this->req->ir['set'][] = ['column' => $col, 'p' => $this->req->p($v)];
    }

    public function setExpr(string $col, string $frag, array $binds): void
    {
        $ps = [];
        foreach ($binds as $v) {
            $ps[] = $this->req->p($v);
        }
        $this->req->ir['set'][] = ['column' => $col, 'expr' => $frag, 'ps' => $ps];
    }

    public function plus(string $col, int|float $v): void
    {
        $this->req->ir['set'][] = ['column' => $col, 'plus_p' => $this->req->p($v)];
    }

    public function minus(string $col, int|float $v): void
    {
        $this->req->ir['set'][] = ['column' => $col, 'minus_p' => $this->req->p($v)];
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
}
