<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * Turns a validated request into a plan: SQL text with bind slots and the
 * assembly of the result (docs/spec/protocol.md §2).
 */
final class Planner
{
    public function __construct(private readonly RuntimeModel $m, private readonly Dialect $d)
    {
    }

    /** @return array{manifest_hash: string, kind: string, steps: list<array>} */
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
            case 'restore':
                $steps->add($this->restoreStep($r));
                break;
            case 'restart_identity':
                $steps->add($this->restartIdentityStep($r));
                break;
            default:
                $this->selectStep($steps, $r, $r['kind'], $r['agg'] ?? '', null);
        }
        return ['manifest_hash' => $this->m->manifestHash, 'kind' => $r['kind'],
            'steps' => array_map(static fn(PlanStep $s): array => $s->toArray(), $steps->steps)];
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
        $sql = 'SELECT ';
        $asm = new PlanAssemble($root->ent['entity'], $root->alias);
        $outNames = [];
        $idx = 0;
        $groupCount = $kind === 'count' && $groupBy !== [];
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
                $asm->key = self::keyRefs($asm, $groupBy);
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
            $sql .= ', ROW_NUMBER() OVER (PARTITION BY ' . implode(', ', $this->qualified($root, $rc->childKeys))
                . $order . ') AS ' . $this->d->quote('orm_rn');
        }
        $sql .= ' FROM ' . $b->table($root->ent) . ' AS ' . $this->d->quote($root->alias);
        if (($q['force_index'] ?? '') !== '') {
            $sql .= $this->d->forceIndex($q['force_index']);
        }
        $sql .= $this->renderJoins($b, $root);
        $where = [];
        if ($rc !== null) {
            $keyTypes = array_map(static fn(string $key): string =>
                RuntimeModel::column($root->ent, $key)['type'], $rc->childKeys);
            if (count($rc->childKeys) === 1) {
                $where[] = $this->qcol($root, $rc->childKeys[0]) . ' IN ('
                    . $b->parent($rc->parentStep, $keyTypes) . ')';
            } else {
                $where[] = '(' . implode(', ', $this->qualified($root, $rc->childKeys)) . ') IN (('
                    . $b->parent($rc->parentStep, $keyTypes) . '))';
            }
        }
        if ($root->ent['soft_delete'] !== '') {
            $where[] = $this->qcol($root, $root->ent['soft_delete']) . ' IS NULL';
        }
        if (($q['where']['items'] ?? []) !== []) {
            $where[] = $this->renderGroup($b, $root, $q['where'], $rc === null);
        }
        $this->collectJoinWhere($b, $root, $where);
        if ($where !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        // The validator admits group_by only on count and group_count.
        if ($groupBy !== []) {
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
                $keys = array_map(fn(string $k): string =>
                    $w . '.' . $this->d->quote($root->alias . '__' . $k), $rc->childKeys);
                $sql = 'SELECT ' . implode(', ', $cols) . ' FROM (' . $sql . ') AS ' . $w . ' WHERE ' . $w . '.'
                    . $this->d->quote('orm_rn') . ' <= ' . $perParent
                    . ' ORDER BY ' . implode(', ', $keys) . ', ' . $w . '.' . $this->d->quote('orm_rn');
            } else {
                $sql .= $this->renderOrder($b, $root, $q);
                if ($kind === 'one' && $rc === null) {
                    $sql .= $this->d->limit(0, 1);
                } elseif (isset($q['limit'])) {
                    $sql .= $this->d->limit($q['limit']['offset'] ?? 0, $q['limit']['count']);
                }
                if ($lock !== '') {
                    $suffix = $this->d->rowLock($lock) ?? throw self::err(Code::CAPABILITY_UNSUPPORTED,
                        "{$this->d->name} row lock \"$lock\" is not supported");
                    $sql .= $suffix;
                }
            }
        }
        $st = new PlanStep('main', $sql, $lock, $b->slots, $b->tables());
        if ($kind === 'count' && $steps->steps !== []) {
            $st->role = 'count';
        } elseif ($rc !== null) {
            $st->role = 'relation';
            $st->parent = ['step' => $rc->parentStep, 'keys' => self::keyRefs($rc->parentAsm, $rc->parentKeys)];
            if (isset($q['if_parent'])) {
                $column = $q['if_parent']['column'];
                $st->parent['if_parent'] = ['column' => $column,
                    'index' => self::indexOf($rc->parentAsm, $column), 'param' => $q['if_parent']['p']];
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
            $rc->parentKeys = array_column($r['keys'], 'left');
            $rc->childKeys = array_column($r['keys'], 'right');
            $rc->kind = $r['kind'];
            $target = $this->m->entities[$r['query']['entity']];
            $st = $this->selectStep($steps, $r['query'], 'all', '', $rc);
            $child = new PlanChild($r['rel'], $rc->kind);
            $child->step = $st->id;
            $child->parentKeys = self::keyRefs($asm, $rc->parentKeys);
            $child->childKeys = self::keyRefs($st->assemble, $rc->childKeys);
            $child->flatten = !empty($r['query']['flatten']);
            // owned when the target holds the key: this row's primary key on the left, not the target's on the
            // right
            $child->cascade = empty($r['query']['no_cascade_delete']) && $rc->parentKeys === $s->ent['pk']
                && $rc->childKeys !== $target['pk'];
            $keyBy = $r['query']['key_by'] ?? '';
            $child->key = self::keyRefs($st->assemble, $keyBy !== '' ? [$keyBy]
                : $this->m->entities[$st->assemble->entity]['pk']);
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
            $col = isset($o['fn']) ? $this->columnFunction($root, $o['column'], $o['fn'])
                : $this->qcol($root, $o['column']);
            // A NOT NULL column keeps its btree order; one that can be NULL sorts NULL first ascending and last
            // descending.
            $nulls = RuntimeModel::column($root->ent, $o['column'])['nullable']
                ? $this->d->nullsOrder(!empty($o['desc'])) : '';
            $parts[] = $col . (!empty($o['desc']) ? ' DESC' : ' ASC') . $nulls;
        }
        return $parts === [] ? '' : ' ORDER BY ' . implode(', ', $parts);
    }

    private function renderGroupBy(PlanScope $root, array $q): string
    {
        return implode(', ', $this->qualified($root, $q['group_by'] ?? []));
    }

    /** The grouped columns and row_count of a grouped count. */
    private function groupCountList(PlanScope $s, PlanAssemble $asm, int &$idx, array &$outNames): string
    {
        $parts = [];
        foreach ($s->q['group_by'] ?? [] as $name) {
            $col = RuntimeModel::column($s->ent, $name);
            $expr = $this->readColumn($this->qcol($s, $name), $col);
            $out = $s->alias . '__' . $name;
            $parts[] = $expr . ' AS ' . $this->d->quote($out);
            $outNames[] = $out;
            $asm->columns[] = self::outCol($idx++, $name, $name, $col['type'], $this->clientStyles($col));
        }
        $out = $s->alias . '__row_count';
        $parts[] = 'COUNT(*) AS ' . $this->d->quote($out);
        $outNames[] = $out;
        $asm->columns[] = self::outCol($idx++, 'row_count', '', 'i64', []);
        return implode(', ', $parts);
    }

    private static function outCol(int $index, string $name, string $column, string $type, array $styles,
        bool $hidden = false): array
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
        $projection = $this->projection($s);
        foreach ($projection as $c) {
            $col = $c['column'] !== '' ? RuntimeModel::column($s->ent, $c['column']) : null;
            if ($col !== null && RuntimeModel::encrypted($col)) {
                $hasAes = true;
            }
            $styles = [];
            $type = 'string';
            if (isset($c['fn'])) {
                $expr = $this->columnFunction($s, $c['column'], $c['fn']);
                $type = Validator::functionType($c['fn']['name'], $col);
                $col = null;
            } elseif (isset($c['sub'])) {
                $expr = '(' . $this->subSelect($b, $s, $c['sub']) . ')';
                $type = $this->subType($c['sub']);
            } else {
                $expr = $this->readColumn($this->qcol($s, $c['column']), $col);
                $styles = $this->clientStyles($col);
            }
            $parts[] = $expr . ' AS ' . $this->d->quote($s->alias . '__' . $c['name']);
            $outNames[] = $s->alias . '__' . $c['name'];
            if ($col !== null) {
                $type = $col['type'];
            }
            $asm->columns[] = self::outCol($idx++, $c['name'], $c['column'], $type, $styles);
        }
        if ($hasAes && !in_array($s->ent['aes_version'], array_column($projection, 'column'), true)) {
            // A row that reads an AES column also reads the key version column, which was not selected, hidden
            // along with it.
            $name = $s->ent['aes_version'];
            $version = RuntimeModel::column($s->ent, $name) ?? throw self::err(Code::SCHEMA_INVALID,
                "{$s->ent['entity']}: an AES column requires the aes_version setting");
            $parts[] = $this->qcol($s, $name) . ' AS ' . $this->d->quote($s->alias . '__' . $name);
            $outNames[] = $s->alias . '__' . $name;
            $asm->columns[] = self::outCol($idx++, $name, $name, $version['type'], [], true);
        }
        foreach ($s->q['joins'] ?? [] as $j) {
            $js = $s->joins[$j['rel']];
            $child = new PlanChild($j['rel'], 'join');
            $child->assemble = new PlanAssemble($js->ent['entity'], $js->alias);
            $parts[] = $this->selectList($b, $js, $child->assemble, $idx, $outNames);
            $asm->children[] = $child;
        }
        $asm->key = self::keyRefs($asm, $s->ent['pk']);
        return implode(', ', $parts);
    }

    /** @return list<array{name: string, column: string, fn?: array, sub?: array}> */
    private function projection(PlanScope $s): array
    {
        $c = $s->q['columns'] ?? null;
        $mode = $c['mode'] ?? '';
        $base = [];
        foreach ($s->ent['columns'] as $col) {
            $keep = match ($mode) {
                'all' => true,
                'none' => $col['pk'] || $col['foreign_key'],
                default => $col['select'],
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
            $base = array_values(array_filter($base, fn(string $x): bool => !in_array($x, $c['remove'], true)
                || RuntimeModel::column($s->ent, $x)['pk']));
        }
        // columns relation steps bind or key on are always selected
        $need = $s->extra;
        foreach ($s->q['relations'] ?? [] as $r) {
            array_push($need, ...array_column($r['keys'], 'left'));
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
        foreach (['fn', 'sub'] as $kind) {
            $named = $c[$kind] ?? [];
            ksort($named, SORT_STRING);
            foreach ($named as $name => $v) {
                $out[] = match ($kind) {
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
            $conditions = [$this->qcol($s, $j['left']) . ' = ' . $this->qcol($js, $j['right'])];
            // A joined entity's soft-deleted rows never meet the parent: the condition sits in ON, so a left join
            // gives null.
            if ($js->ent['soft_delete'] !== '') {
                $conditions[] = $this->qcol($js, $js->ent['soft_delete']) . ' IS NULL';
            }
            $sql .= $kw . $b->table($js->ent) . ' AS ' . $this->d->quote($js->alias) . ' ON '
                . implode(' AND ', $conditions);
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
        $grouped = $top ? $out : "($out)";
        return empty($g['not']) ? $grouped : "NOT $grouped";
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
        if ($op === 'tuple_in' || $op === 'tuple_not_in') {
            $rows = [];
            foreach (array_chunk($p['ps'], count($p['cols'])) as $values) {
                $row = [];
                foreach ($p['cols'] as $k => $name) {
                    $row[] = $this->renderValue($b, RuntimeModel::column($s->ent, $name), $values[$k]);
                }
                $rows[] = $row;
            }
            return $this->d->tupleIn($this->qualified($s, $p['cols']), $rows, $op === 'tuple_not_in');
        }
        if ($op === 'fulltext' || $op === 'fulltext_boolean') {
            $sql = $this->d->fulltext($this->qualified($s, $p['cols']),
                static fn(string $transform): string => $b->param($p['p'], 'text', $transform), $op === 'fulltext_boolean');
            return $sql ?? throw self::err(Code::OPERATOR_NOT_ALLOWED, $op . ' on ' . $s->ent['entity']);
        }
        $col = RuntimeModel::column($s->ent, $p['column']);
        $lhs = $this->qcol($s, $p['column']);
        if (isset($p['sub'])) {
            $inner = $this->subSelect($b, $s, $p['sub']);
            return $lhs . ($op === 'not_in' ? ' NOT IN ' : ' IN ') . '(' . $inner . ')';
        }
        if (isset($p['value'])) {
            $fn = $p['value']['name'];
            // The clock the ORM compares has six fractional digits, and a datetime(p < 6) column is compared with
            // the value extended to six digits (docs/spec/protocol.md "Clock").
            $value = $this->d->valueFunction($fn,
                static fn(): string => $b->param($p['value']['ps'][0], Validator::intervalType($fn)),
                static fn(): string => $b->now(6))
                ?? throw self::err(Code::CAPABILITY_UNSUPPORTED, "$fn is not available on {$this->d->name}");
            if (($col['type'] ?? '') === 'datetime' && $fn !== 'today') {
                $lhs = $this->d->clockOperand($lhs, $col['precision']);
            }
            return $lhs . ' ' . self::cmp($op) . ' ' . $value;
        }
        if (isset($p['fn'])) {
            $fn = $this->columnFunction($s, $p['column'], $p['fn']);
            $type = Validator::functionType($p['fn']['name'], $col);
            return match ($op) {
                'in', 'not_in' => $fn . ($op === 'not_in' ? ' NOT IN ' : ' IN ') . '(' . implode(', ',
                    array_map(static fn(int $i): string => $b->param($i, $type), $p['ps'])) . ')',
                'between' => $fn . ' BETWEEN ' . $b->param($p['ps'][0], $type) . ' AND '
                    . $b->param($p['ps'][1], $type),
                default => $fn . ' ' . self::cmp($op) . ' ' . $b->param($p['p'], $type),
            };
        }
        $aes = RuntimeModel::encrypted($col);
        switch ($op) {
            case 'eq':
            case 'not_eq':
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte':
                if ($aes) {
                    if ($op !== 'eq' && $op !== 'not_eq') {
                        throw self::err(Code::OPERATOR_NOT_ALLOWED,
                            'AES columns support only equality through a declared blind index');
                    }
                    $index = $this->blindIndex($s, $col);
                    return $this->qcol($s, $index) . ' ' . self::cmp($op) . ' '
                        . $b->blindIndex($p['p'], RuntimeModel::column($s->ent, $index)['type']);
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
                if (RuntimeModel::column($rs->ent, $ref) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "{$rs->ent['entity']}.$ref");
                }
                return $lhs . ' ' . self::cmp(substr($op, 0, -4)) . ' ' . $this->qcol($rs, $ref);
            case 'in':
            case 'not_in':
                $keyword = $op === 'not_in' ? 'NOT IN' : 'IN';
                if ($aes) {
                    $index = $this->blindIndex($s, $col);
                    $lhs = $this->qcol($s, $index);
                    $indexType = RuntimeModel::column($s->ent, $index)['type'];
                    $values = array_map(static fn(int $i): string => $b->blindIndex($i, $indexType), $p['ps']);
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
                return $this->d->contains($lhs, $b->colParam($p['p'], $col, 'like_contains'));
            case 'contains_binary':
                return $this->d->containsBinary($lhs,
                    static fn(string $transform): string => $b->colParam($p['p'], $col, $transform));
        }
        throw self::err(Code::OPERATOR_UNKNOWN, $op);
    }

    private function blindIndex(PlanScope $s, array $col): string
    {
        if ($col['blind_index'] === '') {
            throw self::err(Code::IR_INVALID,
                "{$s->ent['entity']}.{$col['name']} requires a declared blind index for equality search");
        }
        return $col['blind_index'];
    }

    /** A column read with its SQL-side read stages; a time(p) column reads as its p-digit text. */
    private function readColumn(string $qcol, array $col): string
    {
        $expr = $this->d->readExpr($qcol, $this->readSqlStyles($col));
        if ($col['type'] === 'uuid') {
            return $this->d->readUuid($expr);
        }
        return $col['type'] === 'time' ? $this->d->readTime($expr, $col['precision'] ?? 0) : $expr;
    }

    /**
     * Binds one value, wrapped for the SQL-side stages; the other secret stages are marked for the executor.
     */
    private function renderValue(PlanBinds $b, array $col, int $i): string
    {
        $styles = $this->sqlStyles($col);
        $host = array_values(array_filter($col['codec'], fn(string $st): bool =>
            in_array($st, RuntimeModel::HOST_STAGES, true) && !$this->d->handlesStyle($st)));
        if ($styles === []) {
            $ph = $b->colParam($i, $col, '', $host);
            return match ($col['type']) {
                'time' => $this->d->writeTime($ph),
                'uuid' => $this->d->writeUuid($ph),
                default => $ph,
            };
        }
        // The type of the value that a SQL-side style function wraps is the type of that function's input.
        return $this->d->writeExpr($b->param($i, self::styleInputType($styles[0]), '', $host), $styles);
    }

    /**
     * The type of value that a SQL-side style function receives at its placeholder. hex receives bytes, and ip
     * receives an IP address text.
     */
    private static function styleInputType(string $style): string
    {
        return $style === 'ip' ? 'text' : 'bytes';
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
            $cur = $cur->joins[$seg] ?? throw self::err(Code::ENTITY_NOT_JOINED, "{$cur->ent['entity']}.$seg");
        }
        return $cur;
    }

    private function sqlStyles(array $col): array
    {
        return array_values(array_filter($col['codec'], fn(string $s): bool => $this->d->handlesStyle($s)));
    }

    /** The stage the dialect decodes in SQL on read. clientStyles leaves the rest to the executor. */
    private function readSqlStyles(array $col): array
    {
        return array_values(array_filter($col['codec'], fn(string $s): bool => $this->d->decodesStyle($s)));
    }

    private function clientStyles(array $col): array
    {
        return array_values(array_filter($col['codec'], fn(string $s): bool => !$this->d->decodesStyle($s)));
    }

    private static function hasAes(array $ent): bool
    {
        foreach ($ent['columns'] as $c) {
            if (RuntimeModel::encrypted($c)) {
                return true;
            }
        }
        return false;
    }

    private static function assignsAes(array $ent, array $set): bool
    {
        foreach ($set as $a) {
            if (RuntimeModel::encrypted(RuntimeModel::column($ent, $a['column']))) {
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
        if (self::assigned($set, $ent['aes_version'])) {
            throw self::err(Code::IR_INVALID,
                $ent['aes_version'] . ' is the AES key version column, which the AES writer manages');
        }
        if (!$complete || !self::assignsAes($ent, $set)) {
            return;
        }
        foreach ($ent['columns'] as $c) {
            if (RuntimeModel::encrypted($c) && !self::assigned($set, $c['name'])) {
                throw self::err(Code::IR_INVALID, 'AES update must assign every AES column; missing ' . $c['name']);
            }
        }
    }

    /**
     * An insert specifies every required column: NOT NULL columns with no default that are not
     * identity, the AES key version the planner writes, or the audit columns the executor writes.
     * A column with a default receives the database default.
     */
    private static function checkRequiredAssignments(array $ent, array $set): void
    {
        $version = self::hasAes($ent) ? $ent['aes_version'] : '';
        foreach ($ent['columns'] as $c) {
            if ($c['nullable'] || $c['default'] || $c['name'] === $ent['identity'] || $c['name'] === $version
                || $c['name'] === $ent['audit'] || self::assigned($set, $c['name'])) {
                continue;
            }
            throw self::err(Code::IR_INVALID, 'required column ' . $ent['entity'] . '.' . $c['name'] . ' is not set');
        }
    }

    private static function withBlindIndexes(array $ent, array $set): array
    {
        foreach ($set as $a) {
            $col = RuntimeModel::column($ent, $a['column']);
            $target = $col['blind_index'];
            if (!RuntimeModel::encrypted($col) || $target === '' || self::assigned($set, $target)) {
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
            if ($c['blind_index'] === $target) {
                return $c;
            }
        }
        return null;
    }

    /** The columns of the one key an upsert conflicts on, which the validator has checked. */
    private static function conflictTarget(array $ent, array $set): array
    {
        return Validator::conflictKey($ent, $set);
    }

    private function renderAssign(PlanBinds $b, array $ent, array $col, array $a): string
    {
        if (self::blindIndexSource($ent, $col['name']) !== null) {
            if (isset($a['plus_p']) || isset($a['minus_p'])) {
                throw self::err(Code::IR_INVALID, 'blind index assignment must use its AES source value');
            }
            if (!empty($a['null'])) {
                return 'NULL';
            }
            $start = count($b->slots);
            return self::markAssigned($b, $start, $col, $b->blindIndex($a['p'], $col['type']));
        }
        // table-qualified: a bare name is ambiguous inside ON CONFLICT DO UPDATE
        $q = $this->d->quote($ent['table']) . '.' . $this->d->quote($col['name']);
        if (isset($a['plus_p'])) {
            return $q . ' + ' . $b->colParam($a['plus_p'], $col);
        }
        if (isset($a['minus_p'])) {
            // clamp at zero
            $ph = $b->colParam($a['minus_p'], $col);
            return "CASE WHEN $q > $ph THEN $q - " . $b->colParam($a['minus_p'], $col) . ' ELSE 0 END';
        }
        if (!empty($a['null'])) {
            return 'NULL';
        }
        $start = count($b->slots);
        return self::markAssigned($b, $start, $col, $this->renderValue($b, $col, $a['p']));
    }

    /**
     * Marks the param slots of $b from $start as the assignment of $col and returns $sql: a slot of a non-null column
     * carries the column, and its executor refuses a NULL value.
     */
    private static function markAssigned(PlanBinds $b, int $start, array $col, string $sql): string
    {
        if (!$col['nullable']) {
            for ($k = $start; $k < count($b->slots); $k++) {
                if ($b->slots[$k]['from'] === 'param') {
                    $b->slots[$k]['not_null'] = true;
                    $b->slots[$k]['column'] = $col['name'];
                }
            }
        }
        return $sql;
    }

    private function insertStep(array $r): PlanStep
    {
        $b = new PlanBinds($this->d);
        $ent = $this->m->entities[$r['entity']];
        $set = self::withBlindIndexes($ent, $r['set']);
        self::checkAesAssignments($ent, $set, false);
        self::checkRequiredAssignments($ent, $set);
        $versioned = self::hasAes($ent);
        $audited = $ent['audit'] !== '';
        // A dialect that uses the executor clock (hostNow) uses the executor clock, truncated to the column's
        // fractional digits, for a `default now` column the user did not assign
        // (docs/spec/protocol.md "Clock").
        $clocked = [];
        if ($this->d->hostNow()) {
            foreach ($ent['columns'] as $c) {
                if ($c['default_now'] && !self::assigned($set, $c['name'])) {
                    $clocked[] = $c;
                }
            }
        }
        // load keeps rows as the stored keys, so it accepts and requires the identity column's value.
        $load = $r['load'] ?? false;
        if ($load && $ent['identity'] !== '' && !self::assignsValue($set, $ent['identity'])) {
            throw self::err(Code::IR_INVALID,
                "load of {$ent['entity']} needs a value for the identity column {$ent['identity']}");
        }
        $cols = [];
        $vals = [];
        foreach ($set as $a) {
            $col = RuntimeModel::column($ent, $a['column']);
            if ($col['name'] === $ent['identity'] && !$load) {
                throw self::err(Code::IR_INVALID, 'cannot set identity column ' . $a['column']);
            }
            $cols[] = $this->d->quote($a['column']);
            $vals[] = $this->renderAssign($b, $ent, $col, $a);
        }
        if ($versioned) {
            $cols[] = $this->d->quote($ent['aes_version']);
            $vals[] = $b->config('aes_version', RuntimeModel::column($ent, $ent['aes_version'])['type']);
        }
        if ($audited) {
            $cols[] = $this->d->quote($ent['audit']);
            $vals[] = $b->audit($ent);
        }
        foreach ($clocked as $c) {
            $cols[] = $this->d->quote($c['name']);
            $vals[] = $b->now($c['precision']);
        }
        $sql = 'INSERT INTO ' . $b->table($ent) . ' (' . implode(', ', $cols) . ') VALUES ('
            . implode(', ', $vals) . ')';
        $rows = $r['rows'] ?? [];
        if ($rows !== []) {
            // derived blind-index columns take the value of their AES source column
            $given = array_column($r['set'], 'column');
            $source = [];
            foreach ($set as $i => $a) {
                $source[$i] = $i < count($r['set']) ? $i
                    : array_search(self::blindIndexSource($ent, $a['column'])['name'], $given, true);
            }
            foreach ($rows as $row) {
                $more = [];
                foreach ($set as $i => $a) {
                    $more[] = $this->renderAssign($b, $ent, RuntimeModel::column($ent, $a['column']),
                        ['column' => $a['column'], 'p' => $row[$source[$i]]]);
                }
                if ($versioned) {
                    $more[] = $b->config('aes_version', RuntimeModel::column($ent, $ent['aes_version'])['type']);
                }
                if ($audited) {
                    $more[] = $b->audit($ent);
                }
                foreach ($clocked as $c) {
                    $more[] = $b->now($c['precision']);
                }
                $sql .= ', (' . implode(', ', $more) . ')';
            }
            return new PlanStep('main', $sql, '', $b->slots, $b->tables());
        }
        if (($r['on_duplicate'] ?? []) !== []) {
            $duplicate = self::withBlindIndexes($ent, $r['on_duplicate']);
            self::checkAesAssignments($ent, $duplicate, true);
            $sets = [];
            foreach ($duplicate as $a) {
                $sets[] = $this->d->quote($a['column']) . ' = '
                    . $this->renderAssign($b, $ent, RuntimeModel::column($ent, $a['column']), $a);
            }
            if (self::assignsAes($ent, $duplicate)) {
                $sets[] = $this->d->quote($ent['aes_version']) . ' = '
                    . $b->config('aes_version', RuntimeModel::column($ent, $ent['aes_version'])['type']);
            }
            if ($audited) {
                $sets[] = $this->d->quote($ent['audit']) . ' = ' . $b->audit($ent);
            }
            $identity = $ent['identity'];
            if ($identity !== '' && !$this->d->insertReturningId()) {
                // MySQL: make the last insert id report the existing row
                $sets[] = $this->d->quote($identity) . ' = LAST_INSERT_ID(' . $this->d->quote($identity) . ')';
            }
            $sql .= $this->d->upsert(self::conflictTarget($ent, $set), implode(', ', $sets));
        }
        if ($this->d->insertReturningId() && $ent['identity'] !== '') {
            $sql .= ' RETURNING ' . $this->d->quote($ent['identity']);
        }
        return new PlanStep('main', $sql, '', $b->slots, $b->tables());
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
            $col = RuntimeModel::column($ent, $a['column']);
            $sets[] = $this->d->quote($a['column']) . ' = ' . $this->renderAssign($b, $ent, $col, $a);
        }
        if (self::assignsAes($ent, $set)) {
            $sets[] = $this->d->quote($ent['aes_version']) . ' = '
                . $b->config('aes_version', RuntimeModel::column($ent, $ent['aes_version'])['type']);
        }
        // the updated time is always assigned: optimistic locking needs the same behavior everywhere
        $updated = $ent['updated'];
        if ($updated !== '' && !self::assigned($r['set'], $updated)) {
            $sets[] = $this->d->quote($updated) . ' = ' . $this->clock($b, RuntimeModel::column($ent, $updated));
        }
        if ($ent['audit'] !== '') {
            $sets[] = $this->d->quote($ent['audit']) . ' = ' . $b->audit($ent);
        }
        $where = $this->renderGroup($b, $root, $r['where'], true);
        if (isset($r['optimistic'])) {
            $column = $r['optimistic']['column'];
            $where .= ' AND ' . $this->qcol($root, $column) . ' = '
                . $this->renderValue($b, RuntimeModel::column($ent, $column), $r['optimistic']['p']);
        }
        if ($ent['soft_delete'] !== '') {
            $where .= ' AND ' . $this->qcol($root, $ent['soft_delete']) . ' IS NULL';
        }
        return new PlanStep('main', 'UPDATE ' . $b->table($ent) . ' SET ' . implode(', ', $sets) . ' WHERE '
            . $where, '', $b->slots, $b->tables());
    }

    /**
     * The statement time that updated and soft delete write to datetime columns.
     * A dialect that uses the executor clock (hostNow) uses the `now` slot truncated to the column's fractional
     * digits; MySQL uses
     * CURRENT_TIMESTAMP(p) as the database clock.
     */
    private function clock(PlanBinds $b, array $col): string
    {
        return $this->d->hostNow() ? $b->now($col['precision']) : $this->d->now($col['precision']);
    }

    private function deleteStep(array $r): PlanStep
    {
        $b = new PlanBinds($this->d);
        $ent = $this->m->entities[$r['entity']];
        $root = $this->scopes($r, $ent['table'], null);
        $soft = $ent['soft_delete'];
        $sets = '';
        if ($soft !== '') {
            $sets = $this->d->quote($soft) . ' = ' . $this->clock($b, RuntimeModel::column($ent, $soft));
            if ($ent['audit'] !== '') {
                // Soft delete is an update of an audited row, so it records the audit of the deleting transaction.
                $sets .= ', ' . $this->d->quote($ent['audit']) . ' = ' . $b->audit($ent);
            }
        }
        $where = $this->renderGroup($b, $root, $r['where'], true);
        if ($soft !== '') {
            $where .= ' AND ' . $this->qcol($root, $soft) . ' IS NULL';
            return new PlanStep('main', 'UPDATE ' . $b->table($ent) . ' SET ' . $sets . ' WHERE ' . $where, '',
                $b->slots, $b->tables());
        }
        return new PlanStep('main', 'DELETE FROM ' . $b->table($ent) . ' WHERE ' . $where, '', $b->slots, $b->tables());
    }

    /**
     * An update that restores one soft-deleted row. Validator::restoreKey picks a primary key or unique key
     * from the request's set and where; that key column's set value is the condition, and the other set values
     * are rendered as an update of the restored row
     * with the new values written together. The other conditions of where narrow the restore further. Only deleted rows
     * are changed, so rows that are not deleted and rows that do not exist change nothing. The updated column
     * is not written.
     */
    private function restoreStep(array $r): PlanStep
    {
        $ent = $this->m->entities[$r['entity']];
        $parts = Validator::restoreKey($ent, $r);
        $soft = $ent['soft_delete'];
        $set = self::withBlindIndexes($ent, $parts['set']);
        self::checkAesAssignments($ent, $set, true);
        $b = new PlanBinds($this->d);
        $root = $this->scopes($r, $ent['table'], null);
        $sets = [];
        foreach ($set as $a) {
            $col = RuntimeModel::column($ent, $a['column']);
            $sets[] = $this->d->quote($a['column']) . ' = ' . $this->renderAssign($b, $ent, $col, $a);
        }
        if (self::assignsAes($ent, $set)) {
            $sets[] = $this->d->quote($ent['aes_version']) . ' = '
                . $b->config('aes_version', RuntimeModel::column($ent, $ent['aes_version'])['type']);
        }
        $sets[] = $this->d->quote($soft) . ' = NULL';
        if ($ent['audit'] !== '') {
            $sets[] = $this->d->quote($ent['audit']) . ' = ' . $b->audit($ent);
        }
        $where = $this->renderGroup($b, $root, $parts['where'], true) . ' AND '
            . $this->qcol($root, $soft) . ' IS NOT NULL';
        return new PlanStep('main', 'UPDATE ' . $b->table($ent) . ' SET ' . implode(', ', $sets) . ' WHERE '
            . $where, '', $b->slots, $b->tables());
    }

    /** Whether the set assigns a parameter value (p) to a column. */
    private static function assignsValue(array $set, string $column): bool
    {
        foreach ($set as $a) {
            if ($a['column'] === $column && isset($a['p'])) {
                return true;
            }
        }
        return false;
    }

    /**
     * The statement that restarts the entity's identity from the value after the largest key of its table: the
     * next generated
     * key is the largest key plus 1, or 1 if the table is empty. Runs after loading rows with keys
     * specified by load.
     */
    private function restartIdentityStep(array $r): PlanStep
    {
        $ent = $this->m->entities[$r['entity']];
        if ($ent['identity'] === '') {
            throw self::err(Code::IR_INVALID, "restart_identity of {$ent['entity']}, which has no identity column");
        }
        $b = new PlanBinds($this->d);
        $b->table($ent);
        return new PlanStep('main', $this->d->restartIdentity($ent['table'], $ent['identity']), '', [], $b->tables());
    }

    private function columnFunction(PlanScope $s, string $column, array $f): string
    {
        return $this->d->columnFunction($f['name'], $this->qcol($s, $column))
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
        $sql .= ' FROM ' . $b->table($root->ent) . ' AS ' . $this->d->quote($root->alias);
        $sql .= $this->renderJoins($b, $root);
        $where = [];
        if ($root->ent['soft_delete'] !== '') {
            $where[] = $this->qcol($root, $root->ent['soft_delete']) . ' IS NULL';
        }
        if (($q['where']['items'] ?? []) !== []) {
            $where[] = $this->renderGroup($b, $root, $q['where'], true);
        }
        $this->collectJoinWhere($b, $root, $where);
        if ($where !== []) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        // A scalar column subquery is ordered and limited to one row, which the validator has checked.
        if (($sub['agg'] ?? '') === '' && isset($q['limit'])) {
            $sql .= $this->renderOrder($b, $root, $q)
                . $this->d->limit($q['limit']['offset'] ?? 0, $q['limit']['count']);
        }
        return $sql;
    }

    private function subType(array $sub): string
    {
        return match ($sub['agg'] ?? '') {
            'count' => 'i64',
            'avg' => 'f64',
            default => RuntimeModel::column($this->m->entities[$sub['query']['entity']],
                $sub['column'] ?? '')['type'] ?? 'string',
        };
    }
}
