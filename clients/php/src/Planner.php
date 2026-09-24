<?php
declare(strict_types=1);

namespace Orm;

/**
 * Turns a validated request into a plan: SQL text with bind slots and the
 * assembly of the result (docs/protocol.md §2).
 */
final class Planner
{
    public function __construct(private readonly Manifest $m, private readonly Dialect $d) {}

    /** @return array{schema_hash: string, kind: string, steps: list<array>} */
    public function compile(array $r): array
    {
        $steps = new PlanSteps();
        switch ($r['kind']) {
            case 'paginate':
                // main (with its relation steps), then the count step found by role
                $this->selectStep($steps, $r, 'all', '', null);
                $this->selectStep($steps, $r, 'count', '', null);
                break;
            case 'insert':
                $steps->add($this->insertStep($r));
                break;
            case 'update':
                $steps->add($this->updateStep($r));
                break;
            case 'delete':
                $steps->add($this->deleteStep($r));
                break;
            default:
                $this->selectStep($steps, $r, $r['kind'], $r['agg'] ?? '', null);
        }
        return ['schema_hash' => $this->m->schemaHash, 'kind' => $r['kind'], 'steps' => array_map(static fn(PlanStep $s): array => $s->toArray(), $steps->steps)];
    }

    private static function err(string $code, string $msg): OrmException
    {
        return new OrmException($code, $msg);
    }

    /** Deterministic aliases: root "a", joins by name, nested joins prefixed by their parent. */
    private function scopes(array $q, string $alias, ?PlanScope $parent): PlanScope
    {
        $s = new PlanScope($this->m->entities[$q['entity']], $alias, $q, $parent);
        foreach ($q['joins'] ?? [] as $j) {
            $ja = ($parent !== null || $alias !== 'a') ? $alias . '__' . $j['rel'] : $j['rel'];
            $s->joins[$j['rel']] = $this->scopes($j['query'], $ja, $s);
        }
        return $s;
    }

    private function qcol(PlanScope $s, string $col): string
    {
        return $this->d->quote($s->alias) . '.' . $this->d->quote($col);
    }

    /** @param list<string> $cols @return list<string> */
    private function qualified(PlanScope $s, array $cols): array
    {
        return array_map(fn(string $c): string => $this->qcol($s, $c), $cols);
    }

    private function selectStep(PlanSteps $steps, array $q, string $kind, string $agg, ?PlanRelation $rc): PlanStep
    {
        $b = new PlanBinds($this->d);
        $root = $this->scopes($q, 'a', null);
        if ($rc !== null) {
            array_push($root->extra, ...$rc->childKeys);
            if (($q['key_by'] ?? '') !== '') {
                $root->extra[] = $q['key_by'];
            }
        }
        $pk = $root->ent['pk'];
        $groupBy = $q['group_by'] ?? [];
        $groupExprs = $q['group_by_expr'] ?? [];
        $sql = 'SELECT ';
        $asm = new PlanAssemble($root->ent['name'], $root->alias);
        $outNames = [];
        $idx = 0;
        $groupCount = $kind === 'count' && ($groupBy !== [] || $groupExprs !== []);
        switch ($kind) {
            case 'count':
                $sql .= $groupCount ? '1' : 'COUNT(*)';
                break;
            case 'sum':
                $sql .= 'COALESCE(SUM(' . $this->qcol($root, $agg) . '), 0)';
                break;
            case 'avg':
                $sql .= 'AVG(' . $this->qcol($root, $agg) . ')';
                break;
            case 'group_count':
                $sql .= $this->groupCountList($root, $asm, $idx, $outNames);
                $asm->key = self::keyRefs($asm, [...$groupBy, ...array_column($groupExprs, 'as')]);
                break;
            default:
                $sql .= $this->selectList($b, $root, $asm, $idx, $outNames);
                $asm->key = self::keyRefs($asm, $pk);
        }
        // rows per parent: ROW_NUMBER() over the match columns; an ordered one-relation keeps the first row
        $perParent = 0;
        if ($rc !== null) {
            $perParent = $q['limit_per_parent'] ?? 0;
            if ($perParent === 0 && $rc->kind === 'one' && ($q['order'] ?? []) !== []) {
                $perParent = 1;
            }
        }
        if ($perParent > 0) {
            $order = $this->renderOrder($b, $root, $q);
            if ($order === '') {
                $order = ' ORDER BY ' . $this->qcol($root, $pk[0]) . ' ASC';
            }
            $sql .= ', ROW_NUMBER() OVER (PARTITION BY ' . implode(', ', $this->qualified($root, $rc->childKeys)) . $order . ') AS ' . $this->d->quote('orm_rn');
        }
        $sql .= ' FROM ' . $this->d->quote($root->ent['table']) . ' AS ' . $this->d->quote($root->alias);
        if (($q['force_index'] ?? '') !== '') {
            $sql .= $this->d->forceIndex($q['force_index']);
        }
        $sql .= $this->renderJoins($b, $root);
        $where = [];
        if ($rc !== null) {
            if (count($rc->childKeys) === 1) {
                $where[] = $this->qcol($root, $rc->childKeys[0]) . ' IN (' . $b->parent($rc->parentStep) . ')';
            } else {
                $where[] = '(' . implode(', ', $this->qualified($root, $rc->childKeys)) . ') IN ((' . $b->parent($rc->parentStep) . '))';
            }
        }
        if (($root->ent['soft_delete'] ?? '') !== '') {
            $where[] = $this->qcol($root, $root->ent['soft_delete']) . ' IS NULL';
        }
        if (($q['where']['items'] ?? []) !== []) {
            $where[] = $this->renderGroup($b, $root, $q['where'], $rc === null);
        }
        $this->collectJoinWhere($b, $root, $where);
        if ($where !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        if (($groupBy !== [] || $groupExprs !== []) && ($kind === 'one' || $kind === 'all' || $groupCount || $kind === 'group_count')) {
            $sql .= ' GROUP BY ' . $this->renderGroupBy($root, $q);
        }
        if ($groupCount) {
            $sql = 'SELECT COUNT(*) FROM (' . $sql . ') AS ' . $this->d->quote('orm_g');
        }
        $lock = $q['lock'] ?? '';
        if ($kind === 'one' || $kind === 'all' || $kind === 'group_count') {
            if ($perParent > 0) {
                // keep the output columns in order, drop orm_rn, cut at n per parent
                $w = $this->d->quote('orm_w');
                $cols = array_map(fn(string $n): string => $w . '.' . $this->d->quote($n), $outNames);
                $keys = array_map(fn(string $k): string => $w . '.' . $this->d->quote($root->alias . '__' . $k), $rc->childKeys);
                $sql = 'SELECT ' . implode(', ', $cols) . ' FROM (' . $sql . ') AS ' . $w . ' WHERE ' . $w . '.' . $this->d->quote('orm_rn') . ' <= ' . $perParent
                    . ' ORDER BY ' . implode(', ', $keys) . ', ' . $w . '.' . $this->d->quote('orm_rn');
            } else {
                $sql .= $this->renderOrder($b, $root, $q);
                if ($kind === 'one' && $rc === null) {
                    $sql .= $this->d->limit(0, 1);
                } elseif (isset($q['limit'])) {
                    $sql .= $this->d->limit($q['limit']['offset'] ?? 0, $q['limit']['count']);
                }
                if ($lock !== '') {
                    $suffix = $this->d->rowLock($lock) ?? throw self::err(Code::CAPABILITY_UNSUPPORTED, "{$this->d->name} row lock \"$lock\" is not supported");
                    $sql .= $suffix;
                }
            }
        }
        $st = new PlanStep('main', $sql, $lock, $b->slots);
        if ($kind === 'count' && $steps->steps !== []) {
            $st->role = 'count';
        } elseif ($rc !== null) {
            $st->role = 'relation';
            $st->parent = ['step' => $rc->parentStep, 'keys' => self::keyRefs($rc->parentAsm, $rc->parentKeys)];
            if (isset($q['if_parent'])) {
                $column = $q['if_parent']['column'];
                $st->parent['if_parent'] = ['column' => $column, 'index' => self::indexOf($rc->parentAsm, $column), 'param' => $q['if_parent']['p']];
            }
        }
        if ($kind === 'one' || $kind === 'all' || $kind === 'group_count') {
            $st->assemble = $asm;
        }
        $id = $steps->add($st);
        if ($st->assemble !== null) {
            $this->relationSteps($steps, $root, $asm, $id);
        }
        return $st;
    }

    /** A step per relation of $s and of its joins; records how the rows attach. */
    private function relationSteps(PlanSteps $steps, PlanScope $s, PlanAssemble $asm, int $stepId): void
    {
        foreach ($s->q['relations'] ?? [] as $r) {
            $rc = new PlanRelation($stepId, $asm);
            if (($r['left'] ?? '') !== '') {
                [$rc->parentKeys, $rc->childKeys, $rc->kind] = [[$r['left']], [$r['right']], $r['kind']];
                $target = $this->m->entities[$r['query']['entity']];
            } else {
                $rel = $s->ent['relations'][$r['rel']];
                $rc->parentKeys = array_column($rel['keys'], 'local');
                $rc->childKeys = array_column($rel['keys'], 'target');
                $rc->kind = $rel['kind'];
                $target = $this->m->entities[$rel['target']];
            }
            $st = $this->selectStep($steps, $r['query'], 'all', '', $rc);
            $child = new PlanChild($r['rel'], $rc->kind);
            $child->step = $st->id;
            $child->parentKeys = self::keyRefs($asm, $rc->parentKeys);
            $child->childKeys = self::keyRefs($st->assemble, $rc->childKeys);
            $child->flatten = !empty($r['query']['flatten']);
            // owned when the target holds the key: this row's primary key on the left, not the target's on the right
            $child->cascade = empty($r['query']['no_cascade_delete']) && $rc->parentKeys === $s->ent['pk'] && $rc->childKeys !== $target['pk'];
            $keyBy = $r['query']['key_by'] ?? '';
            $child->key = self::keyRefs($st->assemble, $keyBy !== '' ? [$keyBy] : $this->m->entities[$st->assemble->entity]['pk']);
            $asm->children[] = $child;
        }
        foreach ($s->q['joins'] ?? [] as $j) {
            foreach ($asm->children as $ch) {
                if ($ch->kind === 'join' && $ch->rel === $j['rel']) {
                    $this->relationSteps($steps, $s->joins[$j['rel']], $ch->assemble, $stepId);
                }
            }
        }
    }

    private static function indexOf(PlanAssemble $a, string $name): int
    {
        foreach ($a->columns as $c) {
            if ($c['name'] === $name) {
                return $c['index'];
            }
        }
        throw self::err(Code::INTERNAL, "column $name is not projected in {$a->entity}");
    }

    /** @param list<string> $cols */
    private static function keyRefs(PlanAssemble $a, array $cols): array
    {
        return array_map(static fn(string $c): array => ['column' => $c, 'index' => self::indexOf($a, $c)], $cols);
    }

    private function renderOrder(PlanBinds $b, PlanScope $root, array $q): string
    {
        $parts = [];
        foreach ($q['order'] ?? [] as $o) {
            if (!empty($o['random'])) {
                $parts[] = $this->d->random();
                continue;
            }
            if (($o['expr'] ?? '') !== '') {
                // a raw order expression carries its own direction
                $parts[] = $this->renderExpr($root, $o['expr']);
                continue;
            }
            $col = isset($o['fn']) ? $this->columnFunction($b, $root, $o['column'], $o['fn']) : $this->qcol($root, $o['column']);
            $parts[] = $col . (!empty($o['desc']) ? ' DESC' : ' ASC');
        }
        return $parts === [] ? '' : ' ORDER BY ' . implode(', ', $parts);
    }

    private function renderGroupBy(PlanScope $root, array $q): string
    {
        $parts = $this->qualified($root, $q['group_by'] ?? []);
        foreach ($q['group_by_expr'] ?? [] as $g) {
            $parts[] = $this->renderExpr($root, $g['expr']);
        }
        return implode(', ', $parts);
    }

    /** The grouped columns and row_count of a grouped count. */
    private function groupCountList(PlanScope $s, PlanAssemble $asm, int &$idx, array &$outNames): string
    {
        $parts = [];
        foreach ($s->q['group_by'] ?? [] as $name) {
            $col = Manifest::column($s->ent, $name);
            $expr = $this->d->readExpr($this->qcol($s, $name), $col['type'], $this->sqlStyles($col));
            $out = $s->alias . '__' . $name;
            $parts[] = $expr . ' AS ' . $this->d->quote($out);
            $outNames[] = $out;
            $asm->columns[] = self::outCol($idx++, $name, $name, $col['type'], $this->appStyles($col));
        }
        foreach ($s->q['group_by_expr'] ?? [] as $g) {
            $out = $s->alias . '__' . $g['as'];
            $parts[] = $this->renderExpr($s, $g['expr']) . ' AS ' . $this->d->quote($out);
            $outNames[] = $out;
            $asm->columns[] = self::outCol($idx++, $g['as'], '', Manifest::column($s->ent, $g['as'])['type'] ?? 'string', []);
        }
        $out = $s->alias . '__row_count';
        $parts[] = 'COUNT(*) AS ' . $this->d->quote($out);
        $outNames[] = $out;
        $asm->columns[] = self::outCol($idx++, 'row_count', '', 'i64', []);
        return implode(', ', $parts);
    }

    private static function outCol(int $index, string $name, string $column, string $type, array $styles, bool $hidden = false): array
    {
        $c = ['index' => $index, 'name' => $name];
        if ($column !== '') {
            $c['column'] = $column;
        }
        $c['type'] = $type;
        if ($styles !== []) {
            $c['styles'] = $styles;
        }
        if ($hidden) {
            $c['hidden'] = true;
        }
        return $c;
    }

    /** The projection of a scope and its joins; join columns become join children. */
    private function selectList(PlanBinds $b, PlanScope $s, PlanAssemble $asm, int &$idx, array &$outNames): string
    {
        $parts = [];
        $hasAes = false;
        foreach ($this->projection($s) as $c) {
            $col = $c['column'] !== '' ? Manifest::column($s->ent, $c['column']) : null;
            if ($col !== null && in_array('aes', $col['styles'] ?? [], true)) {
                $hasAes = true;
            }
            $styles = [];
            $type = 'string';
            if (isset($c['fn'])) {
                $expr = $this->columnFunction($b, $s, $c['column'], $c['fn']);
                $type = self::functionType($c['fn']['name'], $col);
                $col = null;
            } elseif (isset($c['sub'])) {
                $expr = '(' . $this->subSelect($b, $s, $c['sub']) . ')';
                $type = $this->subType($c['sub']);
            } elseif (isset($c['expr'])) {
                $expr = $this->fill($b, $this->renderExpr($s, $c['expr']['sql'] ?? ''), $c['expr']['ps'] ?? []);
            } else {
                $expr = $this->d->readExpr($this->qcol($s, $c['column']), $col['type'], $this->sqlStyles($col));
                $styles = $this->appStyles($col);
            }
            $parts[] = $expr . ' AS ' . $this->d->quote($s->alias . '__' . $c['name']);
            $outNames[] = $s->alias . '__' . $c['name'];
            if ($col !== null) {
                $type = $col['type'];
            }
            $asm->columns[] = self::outCol($idx++, $c['name'], $c['column'], $type, $styles);
        }
        if ($hasAes) {
            $version = Manifest::column($s->ent, 'aes_key_version') ?? throw self::err(Code::SCHEMA_INVALID, "{$s->ent['name']}: AES column requires aes_key_version");
            $parts[] = $this->qcol($s, 'aes_key_version') . ' AS ' . $this->d->quote($s->alias . '__aes_key_version');
            $outNames[] = $s->alias . '__aes_key_version';
            $asm->columns[] = self::outCol($idx++, 'aes_key_version', 'aes_key_version', $version['type'], [], true);
        }
        foreach ($s->q['joins'] ?? [] as $j) {
            $js = $s->joins[$j['rel']];
            $child = new PlanChild($j['rel'], 'join');
            $child->assemble = new PlanAssemble($js->ent['name'], $js->alias);
            $parts[] = $this->selectList($b, $js, $child->assemble, $idx, $outNames);
            $asm->children[] = $child;
        }
        $asm->key = self::keyRefs($asm, $s->ent['pk']);
        return implode(', ', $parts);
    }

    /** @return list<array{name: string, column: string, expr?: array, fn?: array, sub?: array}> */
    private function projection(PlanScope $s): array
    {
        $c = $s->q['columns'] ?? null;
        $mode = $c['mode'] ?? '';
        $base = [];
        foreach ($s->ent['columns'] as $col) {
            $keep = match ($mode) {
                'all' => true,
                'none' => !empty($col['pk']) || !empty($col['fk']),
                default => empty($col['lazy']),
            };
            if ($keep) {
                $base[] = $col['name'];
            }
        }
        foreach ($c['add'] ?? [] as $a) {
            if (!in_array($a, $base, true)) {
                $base[] = $a;
            }
        }
        if (($c['remove'] ?? []) !== []) {
            $base = array_values(array_filter($base, fn(string $x): bool => !in_array($x, $c['remove'], true) || !empty(Manifest::column($s->ent, $x)['pk'])));
        }
        // columns relation steps bind or key on are always selected
        $need = $s->extra;
        foreach ($s->q['relations'] ?? [] as $r) {
            if (($r['left'] ?? '') !== '') {
                $need[] = $r['left'];
            } else {
                array_push($need, ...array_column($s->ent['relations'][$r['rel']]['keys'], 'local'));
            }
            if (isset($r['query']['if_parent'])) {
                $need[] = $r['query']['if_parent']['column'];
            }
        }
        foreach ($need as $x) {
            if (!in_array($x, $base, true)) {
                $base[] = $x;
            }
        }
        foreach ($s->ent['pk'] as $pk) {
            if (!in_array($pk, $base, true)) {
                array_unshift($base, $pk);
            }
        }
        $out = array_map(static fn(string $x): array => ['name' => $x, 'column' => $x], $base);
        foreach (['expr', 'fn', 'sub'] as $kind) {
            $named = $c[$kind] ?? [];
            ksort($named, SORT_STRING);
            foreach ($named as $name => $v) {
                $out[] = match ($kind) {
                    'expr' => ['name' => (string) $name, 'column' => '', 'expr' => $v],
                    'fn' => ['name' => (string) $name, 'column' => $v['column'], 'fn' => $v['fn']],
                    'sub' => ['name' => (string) $name, 'column' => '', 'sub' => $v],
                };
            }
        }
        return $out;
    }

    private function renderJoins(PlanBinds $b, PlanScope $s): string
    {
        $sql = '';
        foreach ($s->q['joins'] ?? [] as $j) {
            $js = $s->joins[$j['rel']];
            $kw = ($j['kind'] ?? '') === 'left' ? ' LEFT JOIN ' : ' INNER JOIN ';
            if (($j['left'] ?? '') !== '') {
                $conditions = [$this->qcol($s, $j['left']) . ' = ' . $this->qcol($js, $j['right'])];
            } else {
                $conditions = array_map(fn(array $k): string => $this->qcol($s, $k['local']) . ' = ' . $this->qcol($js, $k['target']), $s->ent['relations'][$j['rel']]['keys']);
            }
            $sql .= $kw . $this->d->quote($js->ent['table']) . ' AS ' . $this->d->quote($js->alias) . ' ON ' . implode(' AND ', $conditions);
            if (($j['query']['on']['items'] ?? []) !== []) {
                $sql .= ' AND ' . $this->renderGroup($b, $js, $j['query']['on'], true);
            }
            $sql .= $this->renderJoins($b, $js);
        }
        return $sql;
    }

    /** Appends each join's where group that no joined item placed. */
    private function collectJoinWhere(PlanBinds $b, PlanScope $s, array &$where): void
    {
        $placed = [];
        if (isset($s->q['where'])) {
            self::placedJoins($s->q['where'], $placed);
        }
        foreach ($s->q['joins'] ?? [] as $j) {
            $js = $s->joins[$j['rel']];
            if (($j['query']['where']['items'] ?? []) !== [] && !isset($placed[$j['rel']])) {
                $where[] = $this->renderGroup($b, $js, $j['query']['where'], false);
            }
            $this->collectJoinWhere($b, $js, $where);
        }
    }

    private static function placedJoins(array $g, array &$out): void
    {
        foreach ($g['items'] ?? [] as $it) {
            if (isset($it['joined'])) {
                $out[$it['joined']['join']] = true;
            }
            if (isset($it['group'])) {
                self::placedJoins($it['group'], $out);
            }
        }
    }

    /** A group; the top group has no parentheses. */
    private function renderGroup(PlanBinds $b, PlanScope $s, array $g, bool $top): string
    {
        $parts = [];
        foreach ($g['items'] as $i => $it) {
            if (isset($it['pred'])) {
                $conn = $it['pred']['conn'] ?? '';
                $text = $this->renderPred($b, $s, $it['pred']);
            } elseif (isset($it['group'])) {
                $conn = $it['group']['conn'] ?? '';
                $text = $this->renderGroup($b, $s, $it['group'], false);
            } else {
                $conn = $it['joined']['conn'] ?? '';
                $js = $s->joins[$it['joined']['join']];
                $text = $this->renderGroup($b, $js, $js->q['where'], false);
            }
            if ($i > 0) {
                $parts[] = $conn === 'or' ? 'OR' : 'AND';
            }
            $parts[] = $text;
        }
        $out = implode(' ', $parts);
        return $top ? $out : "($out)";
    }

    private static function cmp(string $op): string
    {
        return match ($op) {
            'eq' => '=',
            'not_eq' => '!=',
            'gt' => '>',
            'gte' => '>=',
            'lt' => '<',
            'lte' => '<=',
        };
    }

    private function renderPred(PlanBinds $b, PlanScope $s, array $p): string
    {
        $op = $p['op'] ?? '';
        if ($op !== '' && !$this->d->supports($op)) {
            throw self::err(Code::OPERATOR_NOT_ALLOWED, "$op is not available on {$this->d->name}");
        }
        if (($p['expr'] ?? '') !== '') {
            return '(' . $this->fill($b, $this->renderExpr($s, $p['expr']), $p['ps'] ?? []) . ')';
        }
        if ($op === 'match' || $op === 'match_boolean') {
            $boolean = $op === 'match_boolean';
            return $this->d->fulltext($this->qualified($s, $p['match']), $b->param($p['p'], $boolean ? 'fulltext_boolean' : ''), $boolean);
        }
        if ($op === 'tuple_in' || $op === 'tuple_not_in') {
            $rows = [];
            foreach (array_chunk($p['ps'], count($p['cols'])) as $values) {
                $row = [];
                foreach ($p['cols'] as $k => $name) {
                    $row[] = $this->renderValue($b, Manifest::column($s->ent, $name), $values[$k]);
                }
                $rows[] = $row;
            }
            return $this->d->tupleIn($this->qualified($s, $p['cols']), $rows, $op === 'tuple_not_in');
        }
        $col = Manifest::column($s->ent, $p['column']);
        $lhs = $this->qcol($s, $p['column']);
        if (isset($p['sub'])) {
            $inner = $this->subSelect($b, $s, $p['sub']);
            return $lhs . ($op === 'not_in' ? ' NOT IN ' : ' IN ') . '(' . $inner . ')';
        }
        if (isset($p['value'])) {
            $fn = $p['value']['name'];
            $value = $this->d->valueFunction($fn, static fn(): string => $b->param($p['value']['ps'][0]), static fn(): string => $b->now())
                ?? throw self::err(Code::CAPABILITY_UNSUPPORTED, "$fn is not available on {$this->d->name}");
            return $lhs . ' ' . self::cmp($op) . ' ' . $value;
        }
        if (isset($p['fn'])) {
            $fn = $this->columnFunction($b, $s, $p['column'], $p['fn']);
            return match ($op) {
                'in', 'not_in' => $fn . ($op === 'not_in' ? ' NOT IN ' : ' IN ') . '(' . implode(', ', array_map(static fn(int $i): string => $b->param($i), $p['ps'])) . ')',
                'between' => $fn . ' BETWEEN ' . $b->param($p['ps'][0]) . ' AND ' . $b->param($p['ps'][1]),
                default => $fn . ' ' . self::cmp($op) . ' ' . $b->param($p['p']),
            };
        }
        $aes = in_array('aes', $col['styles'] ?? [], true);
        switch ($op) {
            case 'eq':
            case 'not_eq':
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte':
                if ($aes) {
                    if ($op !== 'eq' && $op !== 'not_eq') {
                        throw self::err(Code::OPERATOR_NOT_ALLOWED, 'AES columns support only equality through a declared blind index');
                    }
                    return $this->qcol($s, $this->blindIndex($s, $col)) . ' ' . self::cmp($op) . ' ' . $b->blindIndex($p['p']);
                }
                return $lhs . ' ' . self::cmp($op) . ' ' . $this->renderValue($b, $col, $p['p']);
            case 'eq_col':
            case 'not_eq_col':
            case 'gt_col':
            case 'gte_col':
            case 'lt_col':
            case 'lte_col':
                $rs = $this->resolvePath($s, $p['ref']['path'] ?? '');
                $ref = $p['ref']['column'] ?? '';
                if (Manifest::column($rs->ent, $ref) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "{$rs->ent['name']}.$ref");
                }
                return $lhs . ' ' . self::cmp(substr($op, 0, -4)) . ' ' . $this->qcol($rs, $ref);
            case 'in':
            case 'not_in':
                $keyword = $op === 'not_in' ? 'NOT IN' : 'IN';
                if ($aes) {
                    $lhs = $this->qcol($s, $this->blindIndex($s, $col));
                    $values = array_map(static fn(int $i): string => $b->blindIndex($i), $p['ps']);
                } else {
                    $values = array_map(fn(int $i): string => $this->renderValue($b, $col, $i), $p['ps']);
                }
                return "$lhs $keyword (" . implode(', ', $values) . ')';
            case 'between':
                $lo = $this->renderValue($b, $col, $p['ps'][0]);
                $hi = $this->renderValue($b, $col, $p['ps'][1]);
                return "$lhs BETWEEN $lo AND $hi";
            case 'is_null':
                return "$lhs IS NULL";
            case 'is_not_null':
                return "$lhs IS NOT NULL";
            case 'contains':
                return $this->d->contains($lhs, $b->param($p['p'], 'like_contains'));
            case 'contains_binary':
                return $this->d->containsBinary($lhs, static fn(string $transform): string => $b->param($p['p'], $transform));
        }
        throw self::err(Code::OPERATOR_UNKNOWN, $op);
    }

    private function blindIndex(PlanScope $s, array $col): string
    {
        if (($col['blind_index'] ?? '') === '') {
            throw self::err(Code::IR_INVALID, "{$s->ent['name']}.{$col['name']} requires a declared blind index for equality search");
        }
        return $col['blind_index'];
    }

    /** Binds one value, wrapped for the SQL-side stages; the other secret stages are marked for the executor. */
    private function renderValue(PlanBinds $b, array $col, int $i): string
    {
        $styles = $this->sqlStyles($col);
        $host = array_values(array_filter($col['styles'] ?? [], fn(string $st): bool => in_array($st, ['aes', 'hex', 'ip'], true) && !$this->d->handlesStyle($st)));
        $ph = $b->param($i, '', $host, self::bindType($col));
        if ($styles === [] && $col['type'] !== 'point') {
            return $ph;
        }
        return $this->d->writeExpr($ph, $col['type'], $styles);
    }

    /** Types executors normalize before binding. */
    private static function bindType(?array $col): string
    {
        return in_array($col['type'] ?? '', ['date', 'time', 'datetime', 'point'], true) ? $col['type'] : '';
    }

    private function resolvePath(PlanScope $s, string $path): PlanScope
    {
        $cur = $s;
        while ($cur->parent !== null) {
            $cur = $cur->parent;
        }
        if ($path === '^') {
            return $cur->outer ?? throw self::err(Code::IR_INVALID, '^ reference outside a subquery');
        }
        if ($path === '') {
            return $cur;
        }
        foreach (explode('/', $path) as $seg) {
            $cur = $cur->joins[$seg] ?? throw self::err(Code::ENTITY_NOT_JOINED, "{$cur->ent['name']}.$seg");
        }
        return $cur;
    }

    /** Checks the `{column}` and backtick names of a fragment and qualifies them. */
    private function renderExpr(PlanScope $s, string $frag): string
    {
        $frag = str_replace(Dialect::CURRENT_TIME_TOKEN, $this->d->currentTime(), $frag);
        $out = '';
        $n = strlen($frag);
        $i = 0;
        while ($i < $n) {
            $c = $frag[$i];
            if ($c !== '{' && $c !== '`') {
                $out .= $c;
                $i++;
                continue;
            }
            $close = $c === '{' ? '}' : '`';
            $j = strpos($frag, $close, $i + 1);
            if ($j === false) {
                throw self::err(Code::IR_INVALID, "unterminated $c in expr");
            }
            $name = substr($frag, $i + 1, $j - $i - 1);
            if (Manifest::column($s->ent, $name) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "{$s->ent['name']}.$name in expr");
            }
            $out .= $this->qcol($s, $name);
            $i = $j + 1;
        }
        return $out;
    }

    /** Replaces each `?` of a fragment with the placeholder of the next bind. */
    private function fill(PlanBinds $b, string $frag, array $ps): string
    {
        if (substr_count($frag, '?') !== count($ps)) {
            throw self::err(Code::IR_INVALID, sprintf('fragment has %d placeholders but %d binds', substr_count($frag, '?'), count($ps)));
        }
        $parts = explode('?', $frag);
        $out = array_shift($parts);
        foreach ($parts as $k => $part) {
            $out .= $b->param($ps[$k]) . $part;
        }
        return $out;
    }

    private function sqlStyles(array $col): array
    {
        return array_values(array_filter($col['styles'] ?? [], fn(string $s): bool => $this->d->handlesStyle($s)));
    }

    private function appStyles(array $col): array
    {
        return array_values(array_filter($col['styles'] ?? [], fn(string $s): bool => !$this->d->handlesStyle($s)));
    }

    private static function hasAes(array $ent): bool
    {
        foreach ($ent['columns'] as $c) {
            if (in_array('aes', $c['styles'] ?? [], true)) {
                return true;
            }
        }
        return false;
    }

    private static function assignsAes(array $ent, array $set): bool
    {
        foreach ($set as $a) {
            if (in_array('aes', Manifest::column($ent, $a['column'])['styles'] ?? [], true)) {
                return true;
            }
        }
        return false;
    }

    private static function assigned(array $set, string $column): bool
    {
        return in_array($column, array_column($set, 'column'), true);
    }

    /** One key version describes the row: an AES write replaces every AES column. */
    private static function checkAesAssignments(array $ent, array $set, bool $complete): void
    {
        if (!self::hasAes($ent)) {
            return;
        }
        if (self::assigned($set, 'aes_key_version')) {
            throw self::err(Code::IR_INVALID, 'aes_key_version is managed by the AES writer');
        }
        if (!$complete || !self::assignsAes($ent, $set)) {
            return;
        }
        foreach ($ent['columns'] as $c) {
            if (in_array('aes', $c['styles'] ?? [], true) && !self::assigned($set, $c['name'])) {
                throw self::err(Code::IR_INVALID, 'AES update must assign every AES column; missing ' . $c['name']);
            }
        }
    }

    private static function withBlindIndexes(array $ent, array $set): array
    {
        foreach ($set as $a) {
            $col = Manifest::column($ent, $a['column']);
            $target = $col['blind_index'] ?? '';
            if ($col === null || !in_array('aes', $col['styles'] ?? [], true) || $target === '' || self::assigned($set, $target)) {
                continue;
            }
            $derived = ['column' => $target];
            if (isset($a['p'])) {
                $derived['p'] = $a['p'];
            }
            if (!empty($a['null'])) {
                $derived['null'] = true;
            }
            $set[] = $derived;
        }
        return $set;
    }

    private static function blindIndexSource(array $ent, string $target): ?array
    {
        foreach ($ent['columns'] as $c) {
            if (($c['blind_index'] ?? '') === $target) {
                return $c;
            }
        }
        return null;
    }

    /** The unique key an upsert conflicts on: the first one fully inserted, else the primary key. */
    private static function conflictTarget(array $ent, array $set): array
    {
        $inserted = array_column($set, 'column');
        foreach ($ent['unique'] ?? [] as $uk) {
            if (array_diff($uk, $inserted) === []) {
                return $uk;
            }
        }
        return $ent['pk'];
    }

    private function renderAssign(PlanBinds $b, array $ent, array $col, array $a): string
    {
        if (self::blindIndexSource($ent, $col['name']) !== null) {
            if (($a['expr'] ?? '') !== '' || isset($a['plus_p']) || isset($a['minus_p'])) {
                throw self::err(Code::IR_INVALID, 'blind index assignment must use its AES source value');
            }
            return !empty($a['null']) ? 'NULL' : $b->blindIndex($a['p']);
        }
        // table-qualified: a bare name is ambiguous inside ON CONFLICT DO UPDATE
        $q = $this->d->quote($ent['table']) . '.' . $this->d->quote($col['name']);
        if (($a['expr'] ?? '') !== '') {
            $scope = new PlanScope($ent, $ent['table'], ['entity' => $ent['name']], null);
            return $this->fill($b, $this->renderExpr($scope, $a['expr']), $a['ps'] ?? []);
        }
        if (isset($a['plus_p'])) {
            return $q . ' + ' . $b->param($a['plus_p']);
        }
        if (isset($a['minus_p'])) {
            // clamp at zero
            $ph = $b->param($a['minus_p']);
            return "CASE WHEN $q > $ph THEN $q - " . $b->param($a['minus_p']) . ' ELSE 0 END';
        }
        if (!empty($a['null'])) {
            return 'NULL';
        }
        return $this->renderValue($b, $col, $a['p']);
    }

    private function insertStep(array $r): PlanStep
    {
        $b = new PlanBinds($this->d);
        $ent = $this->m->entities[$r['entity']];
        $set = self::withBlindIndexes($ent, $r['set']);
        self::checkAesAssignments($ent, $set, false);
        $versioned = self::hasAes($ent) && !self::assigned($set, 'aes_key_version');
        $cols = [];
        $vals = [];
        foreach ($set as $a) {
            $col = Manifest::column($ent, $a['column']);
            if (!empty($col['auto'])) {
                throw self::err(Code::IR_INVALID, 'cannot set auto column ' . $a['column']);
            }
            $cols[] = $this->d->quote($a['column']);
            $vals[] = $this->renderAssign($b, $ent, $col, $a);
        }
        if ($versioned) {
            $cols[] = $this->d->quote('aes_key_version');
            $vals[] = $b->config('aes_version');
        }
        // A dialect without a session time zone stores the executor clock, which
        // is in the connection time zone, instead of its UTC column default.
        $nowCols = [];
        if ($this->d->hostNow()) {
            foreach ($ent['columns'] as $c) {
                if (($c['default'] ?? null) === 'now' && !self::assigned($set, $c['name'])) {
                    $nowCols[] = $c['name'];
                }
            }
        }
        foreach ($nowCols as $c) {
            $cols[] = $this->d->quote($c);
            $vals[] = $b->now();
        }
        $sql = 'INSERT INTO ' . $this->d->quote($ent['table']) . ' (' . implode(', ', $cols) . ') VALUES (' . implode(', ', $vals) . ')';
        $rows = $r['rows'] ?? [];
        if ($rows !== []) {
            // derived blind-index columns take the value of their AES source column
            $given = array_column($r['set'], 'column');
            $source = [];
            foreach ($set as $i => $a) {
                $source[$i] = $i < count($r['set']) ? $i : array_search(self::blindIndexSource($ent, $a['column'])['name'], $given, true);
            }
            foreach ($rows as $row) {
                $more = [];
                foreach ($set as $i => $a) {
                    $more[] = $this->renderAssign($b, $ent, Manifest::column($ent, $a['column']), ['column' => $a['column'], 'p' => $row[$source[$i]]]);
                }
                if ($versioned) {
                    $more[] = $b->config('aes_version');
                }
                foreach ($nowCols as $_) {
                    $more[] = $b->now();
                }
                $sql .= ', (' . implode(', ', $more) . ')';
            }
            return new PlanStep('main', $sql, '', $b->slots);
        }
        if (($r['on_duplicate'] ?? []) !== []) {
            $duplicate = self::withBlindIndexes($ent, $r['on_duplicate']);
            self::checkAesAssignments($ent, $duplicate, true);
            $sets = [];
            foreach ($duplicate as $a) {
                $sets[] = $this->d->quote($a['column']) . ' = ' . $this->renderAssign($b, $ent, Manifest::column($ent, $a['column']), $a);
            }
            if (self::hasAes($ent) && self::assignsAes($ent, $duplicate) && !self::assigned($duplicate, 'aes_key_version')) {
                $sets[] = $this->d->quote('aes_key_version') . ' = ' . $b->config('aes_version');
            }
            $auto = $ent['auto'] ?? '';
            if ($auto !== '' && !$this->d->insertReturningId()) {
                // MySQL: make the last insert id report the existing row
                $sets[] = $this->d->quote($auto) . ' = LAST_INSERT_ID(' . $this->d->quote($auto) . ')';
            }
            $sql .= $this->d->upsert(self::conflictTarget($ent, $set), implode(', ', $sets));
        }
        if ($this->d->insertReturningId() && ($ent['auto'] ?? '') !== '') {
            $sql .= ' RETURNING ' . $this->d->quote($ent['auto']);
        }
        return new PlanStep('main', $sql, '', $b->slots);
    }

    private function updateStep(array $r): PlanStep
    {
        $b = new PlanBinds($this->d);
        $ent = $this->m->entities[$r['entity']];
        $set = self::withBlindIndexes($ent, $r['set']);
        self::checkAesAssignments($ent, $set, true);
        $root = $this->scopes($r, $ent['table'], null);
        $sets = [];
        foreach ($set as $a) {
            $col = Manifest::column($ent, $a['column']);
            if (!empty($col['pk']) || !empty($col['auto'])) {
                throw self::err(Code::IR_INVALID, 'cannot update ' . $a['column']);
            }
            $sets[] = $this->d->quote($a['column']) . ' = ' . $this->renderAssign($b, $ent, $col, $a);
        }
        if (self::hasAes($ent) && self::assignsAes($ent, $set) && !self::assigned($set, 'aes_key_version')) {
            $sets[] = $this->d->quote('aes_key_version') . ' = ' . $b->config('aes_version');
        }
        // the updated time is always assigned: optimistic locking needs the same behavior everywhere
        $updated = $ent['timestamps']['updated'] ?? '';
        if ($updated !== '' && !self::assigned($r['set'], $updated) && ($col = Manifest::column($ent, $updated)) !== null) {
            $now = $this->d->now();
            if ($this->d->hostNow()) {
                $now = $b->now();
            } elseif (($col['precision'] ?? 0) > 0 && $this->d->name === 'mysql') {
                $now = "CURRENT_TIMESTAMP({$col['precision']})";
            }
            $sets[] = $this->d->quote($updated) . ' = ' . $now;
        }
        $where = $this->renderGroup($b, $root, $r['where'], true);
        if (isset($r['optimistic'])) {
            $where .= ' AND ' . $this->qcol($root, $r['optimistic']['column']) . ' = ' . $b->param($r['optimistic']['p']);
        }
        if (($ent['soft_delete'] ?? '') !== '') {
            $where .= ' AND ' . $this->qcol($root, $ent['soft_delete']) . ' IS NULL';
        }
        return new PlanStep('main', 'UPDATE ' . $this->d->quote($ent['table']) . ' SET ' . implode(', ', $sets) . ' WHERE ' . $where, '', $b->slots);
    }

    private function deleteStep(array $r): PlanStep
    {
        $b = new PlanBinds($this->d);
        $ent = $this->m->entities[$r['entity']];
        $root = $this->scopes($r, $ent['table'], null);
        $soft = $ent['soft_delete'] ?? '';
        $now = '';
        if ($soft !== '') {
            $now = $this->d->hostNow() ? $b->now() : $this->d->now();
        }
        $where = $this->renderGroup($b, $root, $r['where'], true);
        if ($soft !== '') {
            $where .= ' AND ' . $this->qcol($root, $soft) . ' IS NULL';
            return new PlanStep('main', 'UPDATE ' . $this->d->quote($ent['table']) . ' SET ' . $this->d->quote($soft) . ' = ' . $now . ' WHERE ' . $where, '', $b->slots);
        }
        return new PlanStep('main', 'DELETE FROM ' . $this->d->quote($ent['table']) . ' WHERE ' . $where, '', $b->slots);
    }

    private function columnFunction(PlanBinds $b, PlanScope $s, string $column, array $f): string
    {
        return $this->d->columnFunction($f['name'], $this->qcol($s, $column), static fn(int $i): string => $b->param($f['ps'][$i]))
            ?? throw self::err(Code::CAPABILITY_UNSUPPORTED, "{$f['name']} is not available on {$this->d->name}");
    }

    /** A subquery for an IN list or a scalar column; `^` refs resolve against $outer. */
    private function subSelect(PlanBinds $b, PlanScope $outer, array $sub): string
    {
        $q = $sub['query'];
        $root = $this->scopes($q, 's' . (++$b->subs), null);
        $root->outer = $outer;
        $column = $sub['column'] ?? '';
        $sql = 'SELECT ' . match ($sub['agg'] ?? '') {
            'sum' => 'COALESCE(SUM(' . $this->qcol($root, $column) . '), 0)',
            'avg' => 'AVG(' . $this->qcol($root, $column) . ')',
            'count' => 'COUNT(*)',
            default => $this->qcol($root, $column),
        };
        $sql .= ' FROM ' . $this->d->quote($root->ent['table']) . ' AS ' . $this->d->quote($root->alias);
        $sql .= $this->renderJoins($b, $root);
        $where = [];
        if (($root->ent['soft_delete'] ?? '') !== '') {
            $where[] = $this->qcol($root, $root->ent['soft_delete']) . ' IS NULL';
        }
        if (($q['where']['items'] ?? []) !== []) {
            $where[] = $this->renderGroup($b, $root, $q['where'], true);
        }
        $this->collectJoinWhere($b, $root, $where);
        if ($where !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        if (($q['group_by'] ?? []) !== []) {
            $sql .= ' GROUP BY ' . $this->renderGroupBy($root, $q);
        }
        return $sql;
    }

    private static function functionType(string $name, ?array $col): string
    {
        return match ($name) {
            'day_of_week', 'year', 'month' => 'i64',
            'date' => 'date',
            'distance', 'point_x', 'point_y' => 'f64',
            default => $col['type'] ?? 'string',
        };
    }

    private function subType(array $sub): string
    {
        return match ($sub['agg'] ?? '') {
            'count' => 'i64',
            'avg' => 'f64',
            default => Manifest::column($this->m->entities[$sub['query']['entity']], $sub['column'] ?? '')['type'] ?? 'string',
        };
    }
}

/** @internal one entity occurrence of a statement: the root, a join, or a subquery root */
final class PlanScope
{
    /** @var array<string, PlanScope> */
    public array $joins = [];
    public ?PlanScope $outer = null;
    /** @var list<string> columns a relation step needs selected */
    public array $extra = [];

    public function __construct(public readonly array $ent, public readonly string $alias, public readonly array $q, public readonly ?PlanScope $parent) {}
}

/** @internal the relation a step loads */
final class PlanRelation
{
    public array $parentKeys = [];
    public array $childKeys = [];
    public string $kind = '';

    public function __construct(public readonly int $parentStep, public readonly PlanAssemble $parentAsm) {}
}

/** @internal the bind slots of one statement */
final class PlanBinds
{
    /** @var list<array> */
    public array $slots = [];
    public int $subs = 0;

    public function __construct(private readonly Dialect $d) {}

    private function add(array $slot): string
    {
        $this->slots[] = $slot;
        return $this->d->placeholder(count($this->slots));
    }

    /** @param list<string> $hostStyles */
    public function param(int $i, string $transform = '', array $hostStyles = [], string $colType = ''): string
    {
        $slot = ['from' => 'param', 'param' => $i];
        if ($transform !== '') {
            $slot['transform'] = $transform;
        }
        if ($hostStyles !== []) {
            $slot['host_styles'] = $hostStyles;
        }
        if ($colType !== '') {
            $slot['col_type'] = $colType;
        }
        return $this->add($slot);
    }

    /** Plaintext the executor hashes with the blind-index key. */
    public function blindIndex(int $i): string
    {
        return $this->param($i, '', ['blind_index']);
    }

    public function config(string $name): string
    {
        return $this->add(['from' => 'config', 'param' => 0, 'name' => $name]);
    }

    /** The executor clock (dialects without a sub-second clock function). */
    public function now(): string
    {
        return $this->add(['from' => 'now', 'param' => 0]);
    }

    /** The one placeholder the executor expands to the parent key values. */
    public function parent(int $step): string
    {
        $slot = ['from' => 'parent', 'param' => 0];
        if ($step !== 0) {
            $slot['step'] = $step;
        }
        return $this->add($slot);
    }
}

/** @internal */
final class PlanSteps
{
    /** @var list<PlanStep> */
    public array $steps = [];

    public function add(PlanStep $st): int
    {
        $st->id = count($this->steps);
        $this->steps[] = $st;
        return $st->id;
    }
}

/** @internal */
final class PlanStep
{
    public int $id = 0;
    public ?PlanAssemble $assemble = null;
    public ?array $parent = null;

    public function __construct(public string $role, public readonly string $sql, public readonly string $lock, public readonly array $slots) {}

    public function toArray(): array
    {
        $out = ['id' => $this->id, 'role' => $this->role, 'sql' => $this->sql];
        if ($this->lock !== '') {
            $out['lock'] = $this->lock;
        }
        $out['bind_slots'] = $this->slots;
        if ($this->assemble !== null) {
            $out['assemble'] = $this->assemble->toArray();
        }
        if ($this->parent !== null) {
            $out['parent'] = $this->parent;
        }
        return $out;
    }
}

/** @internal */
final class PlanAssemble
{
    public array $columns = [];
    /** @var list<PlanChild> */
    public array $children = [];
    public array $key = [];

    public function __construct(public readonly string $entity, public readonly string $alias) {}

    public function toArray(): array
    {
        $out = ['entity' => $this->entity, 'alias' => $this->alias, 'columns' => $this->columns];
        if ($this->children !== []) {
            $out['children'] = array_map(static fn(PlanChild $c): array => $c->toArray(), $this->children);
        }
        $out['key'] = $this->key;
        return $out;
    }
}

/** @internal */
final class PlanChild
{
    public int $step = 0;
    public array $parentKeys = [];
    public array $childKeys = [];
    public array $key = [];
    public bool $flatten = false;
    public bool $cascade = false;
    public ?PlanAssemble $assemble = null;

    public function __construct(public readonly string $rel, public readonly string $kind) {}

    public function toArray(): array
    {
        $out = ['rel' => $this->rel, 'kind' => $this->kind];
        foreach (['step' => $this->step, 'parent_keys' => $this->parentKeys, 'child_keys' => $this->childKeys, 'key' => $this->key, 'flatten' => $this->flatten, 'cascade' => $this->cascade] as $k => $v) {
            if ($v !== 0 && $v !== [] && $v !== false) {
                $out[$k] = $v;
            }
        }
        if ($this->assemble !== null) {
            $out['assemble'] = $this->assemble->toArray();
        }
        return $out;
    }
}
