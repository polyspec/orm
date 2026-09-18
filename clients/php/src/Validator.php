<?php
declare(strict_types=1);

namespace Orm;

/** Validates a request (docs/protocol.md) against the manifest. */
final class Validator
{
    public const IR_VERSION = 1;

    private const CMP = ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte'];
    private const ORDERED = ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null', 'is_not_null'];
    private const OPS_BY_TYPE = [
        'i32' => self::ORDERED, 'i64' => self::ORDERED, 'f64' => self::ORDERED, 'decimal' => self::ORDERED,
        'date' => self::ORDERED, 'time' => self::ORDERED, 'datetime' => self::ORDERED,
        'string' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
        'text' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
        'enum' => ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
        'bool' => ['eq', 'not_eq', 'is_null', 'is_not_null'],
        'inet' => ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
        'bytes' => ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'],
        'jsontext' => ['is_null', 'is_not_null'],
        'point' => ['is_null', 'is_not_null'],
    ];
    private const COL_OPS = ['eq_col', 'not_eq_col', 'gt_col', 'gte_col', 'lt_col', 'lte_col'];
    private const NUMERIC = ['i32', 'i64', 'f64', 'decimal'];

    /** Field types of every record: int, string, bool, list<T>, map<T>, or a record name. */
    private const RECORDS = [
        'Request' => self::QUERY + [
            'ir_version' => 'int', 'schema_hash' => 'string', 'kind' => 'string', 'set' => 'list<Assign>',
            'on_duplicate' => 'list<Assign>', 'rows' => 'list<list<int>>', 'optimistic' => 'Optimist', 'agg' => 'string', 'n_params' => 'int',
        ],
        'Query' => self::QUERY,
        'Columns' => ['mode' => 'string', 'add' => 'list<string>', 'remove' => 'list<string>', 'expr' => 'map<Expr>', 'fn' => 'map<ColFunc>', 'sub' => 'map<Sub>'],
        'Expr' => ['sql' => 'string', 'ps' => 'list<int>'],
        'Func' => ['name' => 'string', 'ps' => 'list<int>'],
        'ColFunc' => ['column' => 'string', 'fn' => 'Func'],
        'Sub' => ['query' => 'Query', 'column' => 'string', 'agg' => 'string'],
        'Join' => ['rel' => 'string', 'kind' => 'string', 'query' => 'Query', 'left' => 'string', 'right' => 'string'],
        'Relation' => ['rel' => 'string', 'query' => 'Query', 'kind' => 'string', 'left' => 'string', 'right' => 'string'],
        'Group' => ['conn' => 'string', 'items' => 'list<Item>'],
        'Item' => ['pred' => 'Pred', 'group' => 'Group', 'joined' => 'JoinedRef'],
        'JoinedRef' => ['conn' => 'string', 'join' => 'string'],
        'Pred' => [
            'conn' => 'string', 'column' => 'string', 'op' => 'string', 'p' => 'int', 'ps' => 'list<int>', 'ref' => 'ColRef',
            'expr' => 'string', 'match' => 'list<string>', 'fn' => 'Func', 'value' => 'Func', 'cols' => 'list<string>', 'sub' => 'Sub',
        ],
        'ColRef' => ['path' => 'string', 'column' => 'string'],
        'Order' => ['column' => 'string', 'expr' => 'string', 'desc' => 'bool', 'random' => 'bool', 'fn' => 'Func'],
        'GroupExpr' => ['expr' => 'string', 'as' => 'string'],
        'Limit' => ['offset' => 'int', 'count' => 'int'],
        'IfParent' => ['column' => 'string', 'p' => 'int'],
        'Assign' => ['column' => 'string', 'p' => 'int', 'null' => 'bool', 'expr' => 'string', 'ps' => 'list<int>', 'plus_p' => 'int', 'minus_p' => 'int'],
        'Optimist' => ['column' => 'string', 'p' => 'int'],
    ];
    private const QUERY = [
        'entity' => 'string', 'columns' => 'Columns', 'on' => 'Group', 'where' => 'Group', 'joins' => 'list<Join>',
        'relations' => 'list<Relation>', 'order' => 'list<Order>', 'group_by' => 'list<string>', 'group_by_expr' => 'list<GroupExpr>',
        'limit' => 'Limit', 'force_index' => 'string', 'lock' => 'string', 'key_by' => 'string', 'flatten' => 'bool',
        'limit_per_parent' => 'int', 'if_parent' => 'IfParent', 'no_cascade_delete' => 'bool',
    ];

    private int $n = 0;

    public function __construct(private readonly Manifest $m) {}

    private static function err(string $code, string $msg): OrmException
    {
        return new OrmException($code, $msg);
    }

    /** Whether op is valid for a column of the given type and styles. */
    public static function opAllowed(array $c, string $op): bool
    {
        if (in_array($op, self::COL_OPS, true) || $op === 'expr' || $op === 'match' || $op === 'match_boolean') {
            return true;
        }
        $styles = $c['styles'] ?? [];
        if ($styles !== [] && $c['type'] !== 'inet') {
            if ($styles[0] === 'aes') {
                return in_array($op, ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'], true);
            }
            return $op === 'is_null' || $op === 'is_not_null';
        }
        return in_array($op, self::OPS_BY_TYPE[$c['type']] ?? [], true);
    }

    public function validate(array $r): void
    {
        self::shape('Request', $r, '');
        if (($r['ir_version'] ?? 0) !== self::IR_VERSION) {
            throw self::err(Code::VERSION_MISMATCH, 'ir_version ' . ($r['ir_version'] ?? 0) . ', engine ' . self::IR_VERSION);
        }
        if (($r['schema_hash'] ?? '') !== $this->m->schemaHash) {
            throw self::err(Code::SCHEMA_HASH_MISMATCH, 'client ' . ($r['schema_hash'] ?? '') . ", engine {$this->m->schemaHash}");
        }
        $kind = $r['kind'] ?? '';
        if (!in_array($kind, ['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate', 'insert', 'update', 'delete'], true)) {
            throw self::err(Code::IR_INVALID, "unknown kind \"$kind\"");
        }
        $this->n = $r['n_params'] ?? 0;
        $this->query($r, '', false, false);
        if (($r['lock'] ?? '') !== '' && $kind !== 'one' && $kind !== 'all') {
            throw self::err(Code::IR_INVALID, 'row lock is only valid on one or all');
        }
        $entity = $r['entity'];
        $ent = $this->m->entities[$entity];
        if ($kind === 'sum' || $kind === 'avg') {
            $agg = $r['agg'] ?? '';
            $c = Manifest::column($ent, $agg) ?? throw self::err(Code::COLUMN_UNKNOWN, "$entity.$agg");
            if (!in_array($c['type'], self::NUMERIC, true)) {
                throw self::err(Code::OPERATOR_NOT_ALLOWED, "$kind on $entity.$agg ({$c['type']})");
            }
        }
        if ($kind === 'group_count' && !self::hasGroupBy($r)) {
            throw self::err(Code::IR_INVALID, 'group_count needs group_by');
        }
        $set = $r['set'] ?? [];
        if ($kind === 'insert' || $kind === 'update') {
            if ($set === []) {
                throw self::err(Code::IR_INVALID, "$kind needs set[]");
            }
            foreach ($set as $a) {
                $this->assign($ent, $a);
            }
        }
        $rows = $r['rows'] ?? [];
        if ($rows !== []) {
            if ($kind !== 'insert' || ($r['on_duplicate'] ?? []) !== []) {
                throw self::err(Code::IR_INVALID, 'rows are only valid on insert without on_duplicate');
            }
            foreach ($set as $a) {
                if (!isset($a['p'])) {
                    throw self::err(Code::IR_INVALID, "multi-row insert assigns $entity.{$a['column']} without a value");
                }
            }
            foreach ($rows as $i => $row) {
                if (count($row) !== count($set)) {
                    throw self::err(Code::IR_INVALID, sprintf('insert row %d has %d values for %d columns', $i + 1, count($row), count($set)));
                }
                $this->params($row);
            }
        }
        if (($r['on_duplicate'] ?? []) !== []) {
            if ($kind !== 'insert') {
                throw self::err(Code::IR_INVALID, 'on_duplicate is only valid on insert');
            }
            foreach ($r['on_duplicate'] as $a) {
                $this->assign($ent, $a);
                $c = Manifest::column($ent, $a['column']);
                if (!empty($c['pk']) || !empty($c['auto'])) {
                    throw self::err(Code::IR_INVALID, "on_duplicate cannot assign $entity.{$a['column']}");
                }
            }
        }
        if (isset($r['optimistic'])) {
            $column = $r['optimistic']['column'] ?? '';
            if (Manifest::column($ent, $column) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "$entity.$column");
            }
            $this->params([$r['optimistic']['p'] ?? 0]);
        }
        if (($kind === 'update' || $kind === 'delete') && ($r['where']['items'] ?? []) === []) {
            throw self::err(Code::IR_INVALID, "$kind without where");
        }
    }

    /** Rejects unknown fields and wrong JSON types, like a strict decoder. */
    private static function shape(string $record, mixed $value, string $path): void
    {
        if (!is_array($value) || ($value !== [] && array_is_list($value))) {
            throw self::err(Code::IR_INVALID, ltrim("$path: object required", ': '));
        }
        $fields = self::RECORDS[$record];
        foreach ($value as $key => $v) {
            $type = $fields[$key] ?? throw self::err(Code::IR_INVALID, "json: unknown field \"$key\"");
            self::typed($type, $v, $path === '' ? (string) $key : "$path.$key");
        }
    }

    private static function typed(string $type, mixed $v, string $path): void
    {
        if ($v === null) {
            return;
        }
        if (str_starts_with($type, 'list<')) {
            if (!is_array($v) || !array_is_list($v)) {
                throw self::err(Code::IR_INVALID, "$path: list required");
            }
            foreach ($v as $item) {
                self::typed(substr($type, 5, -1), $item, $path);
            }
            return;
        }
        if (str_starts_with($type, 'map<')) {
            if (!is_array($v) || ($v !== [] && array_is_list($v))) {
                throw self::err(Code::IR_INVALID, "$path: object required");
            }
            foreach ($v as $item) {
                self::typed(substr($type, 4, -1), $item, $path);
            }
            return;
        }
        $ok = match ($type) {
            'int' => is_int($v),
            'string' => is_string($v),
            'bool' => is_bool($v),
            default => null,
        };
        if ($ok === null) {
            self::shape($type, $v, $path);
            return;
        }
        if (!$ok) {
            throw self::err(Code::IR_INVALID, "$path: $type required");
        }
    }

    private function params(array $ps): void
    {
        foreach ($ps as $i) {
            if ($i < 0 || $i >= $this->n) {
                throw self::err(Code::IR_INVALID, "param index $i out of range (n_params {$this->n})");
            }
        }
    }

    private function assign(array $ent, array $a): void
    {
        $column = $a['column'] ?? '';
        $c = Manifest::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "{$ent['name']}.$column");
        $n = (int) isset($a['p']) + (int) !empty($a['null']) + (int) (($a['expr'] ?? '') !== '') + (int) isset($a['plus_p']) + (int) isset($a['minus_p']);
        if ($n !== 1) {
            throw self::err(Code::IR_INVALID, "set $column: exactly one of p/null/expr/plus_p/minus_p");
        }
        if (!empty($a['null']) && empty($c['nullable'])) {
            throw self::err(Code::IR_INVALID, "set {$ent['name']}.$column to null but column is NOT NULL");
        }
        if ((isset($a['plus_p']) || isset($a['minus_p'])) && !in_array($c['type'], self::NUMERIC, true)) {
            throw self::err(Code::OPERATOR_NOT_ALLOWED, "plus/minus on {$ent['name']}.$column ({$c['type']})");
        }
        foreach (['p', 'plus_p', 'minus_p'] as $k) {
            if (isset($a[$k])) {
                $this->params([$a[$k]]);
            }
        }
        $this->params($a['ps'] ?? []);
    }

    private static function hasGroupBy(array $q): bool
    {
        return ($q['group_by'] ?? []) !== [] || ($q['group_by_expr'] ?? []) !== [];
    }

    private function query(array $q, string $path, bool $isJoin, bool $isRelation): void
    {
        $entity = $q['entity'] ?? '';
        $ent = $this->m->entities[$entity] ?? throw self::err(Code::ENTITY_UNKNOWN, $entity);
        if (isset($q['columns'])) {
            $cols = $q['columns'];
            $mode = $cols['mode'] ?? '';
            if ($mode !== '' && $mode !== 'all' && $mode !== 'none') {
                throw self::err(Code::IR_INVALID, "columns.mode \"$mode\"");
            }
            foreach ([...($cols['add'] ?? []), ...($cols['remove'] ?? [])] as $c) {
                if (Manifest::column($ent, $c) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "$entity.$c");
                }
            }
            $outputs = [];
            foreach ($cols['expr'] ?? [] as $out => $e) {
                $out = (string) $out;
                if (Manifest::column($ent, $out) !== null) {
                    throw self::err(Code::COLUMN_ALIAS_CONFLICT, "$entity.$out already a column");
                }
                $sql = $e['sql'] ?? '';
                if (substr_count($sql, '?') !== count($e['ps'] ?? [])) {
                    throw self::err(Code::IR_INVALID, sprintf('%s.%s expr has %d placeholders but %d binds', $entity, $out, substr_count($sql, '?'), count($e['ps'] ?? [])));
                }
                $this->params($e['ps'] ?? []);
                $outputs[$out] = true;
            }
            foreach ($cols['fn'] ?? [] as $out => $cf) {
                $out = (string) $out;
                if (Manifest::column($ent, $out) !== null || isset($outputs[$out])) {
                    throw self::err(Code::COLUMN_ALIAS_CONFLICT, "$entity.$out is already a row name");
                }
                $outputs[$out] = true;
                $col = Manifest::column($ent, $cf['column'] ?? '') ?? throw self::err(Code::COLUMN_UNKNOWN, "$entity." . ($cf['column'] ?? ''));
                $this->columnFunc($ent, $col, $cf['fn'] ?? []);
            }
            foreach ($cols['sub'] ?? [] as $out => $sub) {
                $out = (string) $out;
                if (Manifest::column($ent, $out) !== null || isset($outputs[$out])) {
                    throw self::err(Code::COLUMN_ALIAS_CONFLICT, "$entity.$out is already a row name");
                }
                $outputs[$out] = true;
                $this->sub($sub, true);
            }
        }
        $joined = [];
        foreach ($q['joins'] ?? [] as $j) {
            $kind = $j['kind'] ?? '';
            $rel = $j['rel'] ?? '';
            if ($kind !== 'inner' && $kind !== 'left') {
                throw self::err(Code::IR_INVALID, "join kind \"$kind\"");
            }
            if ($rel === '' || isset($joined[$rel])) {
                throw self::err(Code::IR_INVALID, "join name \"$rel\" is empty or used twice");
            }
            $left = $j['left'] ?? '';
            $right = $j['right'] ?? '';
            if ($left !== '' || $right !== '') {
                if ($left === '' || $right === '' || !isset($j['query'])) {
                    throw self::err(Code::IR_INVALID, "join $rel: left, right and query are required");
                }
                $target = $this->m->entities[$j['query']['entity'] ?? ''] ?? throw self::err(Code::ENTITY_UNKNOWN, $j['query']['entity'] ?? '');
                if (Manifest::column($ent, $left) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "{$ent['name']}.$left");
                }
                if (Manifest::column($target, $right) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "{$target['name']}.$right");
                }
            } else {
                $r = $ent['relations'][$rel] ?? throw self::err(Code::RELATION_UNKNOWN, "$entity.$rel");
                if (!isset($j['query']) || ($j['query']['entity'] ?? '') !== $r['target']) {
                    throw self::err(Code::IR_INVALID, "join $rel: query entity must be {$r['target']}");
                }
            }
            $joined[$rel] = $j;
            $this->query($j['query'], self::joinPath($path, $rel), true, false);
        }
        if (!$isJoin && isset($q['on'])) {
            throw self::err(Code::IR_INVALID, 'on[] is only valid on join children');
        }
        if (isset($q['on'])) {
            $this->group($ent, $q['on'], $joined);
        }
        if (isset($q['where'])) {
            $this->group($ent, $q['where'], $joined);
            $seen = [];
            self::joinedRefs($q['where'], $seen);
        }
        $relationNames = [];
        foreach ($q['relations'] ?? [] as $r) {
            $rel = $r['rel'] ?? '';
            if ($rel === '' || isset($relationNames[$rel])) {
                throw self::err(Code::COLUMN_ALIAS_CONFLICT, "relation name \"$rel\" is empty or used twice");
            }
            $relationNames[$rel] = true;
            if (Manifest::column($ent, $rel) !== null) {
                throw self::err(Code::COLUMN_ALIAS_CONFLICT, "$entity.$rel is already a column");
            }
            $child = $r['query'] ?? throw self::err(Code::IR_INVALID, "relation $rel needs a query");
            $kind = $r['kind'] ?? '';
            $left = $r['left'] ?? '';
            $right = $r['right'] ?? '';
            if ($left !== '' || $right !== '') {
                if ($left === '' || $right === '' || ($kind !== 'one' && $kind !== 'many')) {
                    throw self::err(Code::IR_INVALID, "relation $rel: left, right and kind one|many are required");
                }
                $target = $this->m->entities[$child['entity'] ?? ''] ?? throw self::err(Code::ENTITY_UNKNOWN, $child['entity'] ?? '');
                if (Manifest::column($ent, $left) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "$entity.$left");
                }
                if (Manifest::column($target, $right) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "{$target['name']}.$right");
                }
            } else {
                $schemaRel = $ent['relations'][$rel] ?? throw self::err(Code::RELATION_UNKNOWN, "$entity.$rel");
                if (($child['entity'] ?? '') !== $schemaRel['target']) {
                    throw self::err(Code::IR_INVALID, "relation $rel: query entity must be {$schemaRel['target']}");
                }
                if ($kind !== '') {
                    throw self::err(Code::IR_INVALID, "relation $rel: kind needs left and right");
                }
                $kind = $schemaRel['kind'];
            }
            if (isset($child['limit'])) {
                throw self::err(Code::LIMIT_IN_RELATION, "$rel: use limit_per_parent");
            }
            if (!empty($child['flatten']) && $kind !== 'one') {
                throw self::err(Code::IR_INVALID, "relation $rel: flatten needs a one relation");
            }
            if (($child['key_by'] ?? '') !== '' && $kind !== 'many') {
                throw self::err(Code::IR_INVALID, "relation $rel: key_by needs a many relation");
            }
            if (isset($child['if_parent']) && Manifest::column($ent, $child['if_parent']['column'] ?? '') === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "$entity." . ($child['if_parent']['column'] ?? '') . ' (if_parent)');
            }
            $this->query($child, self::joinPath($path, $rel), false, true);
        }
        $keyBy = $q['key_by'] ?? '';
        if ($keyBy !== '' && Manifest::column($ent, $keyBy) === null) {
            throw self::err(Code::COLUMN_UNKNOWN, "$entity.$keyBy");
        }
        if (isset($q['if_parent'])) {
            $this->params([$q['if_parent']['p'] ?? 0]);
        }
        if (!$isRelation && ($keyBy !== '' || !empty($q['flatten']) || ($q['limit_per_parent'] ?? 0) > 0 || isset($q['if_parent']) || !empty($q['no_cascade_delete']))) {
            throw self::err(Code::IR_INVALID, "relation-only options on $entity");
        }
        foreach ($q['order'] ?? [] as $o) {
            $column = $o['column'] ?? '';
            $kinds = (int) ($column !== '') + (int) (($o['expr'] ?? '') !== '') + (int) !empty($o['random']);
            if ($kinds !== 1) {
                throw self::err(Code::IR_INVALID, 'order needs exactly one of column, expr, random');
            }
            if ($column !== '') {
                $col = Manifest::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "$entity.$column");
                if (isset($o['fn'])) {
                    $this->columnFunc($ent, $col, $o['fn']);
                }
            } elseif (isset($o['fn'])) {
                throw self::err(Code::IR_INVALID, 'order function needs a column');
            }
        }
        $groups = [];
        foreach ($q['group_by'] ?? [] as $g) {
            if (Manifest::column($ent, $g) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "$entity.$g");
            }
            $groups[$g] = true;
        }
        foreach ($q['group_by_expr'] ?? [] as $g) {
            $expr = trim($g['expr'] ?? '');
            $as = trim($g['as'] ?? '');
            if ($expr === '' || $as === '') {
                throw self::err(Code::IR_INVALID, 'group_by_expr needs expr and as');
            }
            if (str_contains($g['expr'], '?')) {
                throw self::err(Code::IR_INVALID, 'group_by_expr does not accept parameters');
            }
            if (isset($groups[$g['as']])) {
                throw self::err(Code::IR_INVALID, "duplicate group output {$g['as']}");
            }
            $groups[$g['as']] = true;
        }
        if (isset($q['limit']) && (($q['limit']['offset'] ?? 0) < 0 || ($q['limit']['count'] ?? 0) <= 0)) {
            throw self::err(Code::IR_INVALID, 'limit offset>=0, count>0');
        }
        $lock = $q['lock'] ?? '';
        if ($lock !== '' && !in_array($lock, ['update', 'share', 'update_nowait', 'share_nowait'], true)) {
            throw self::err(Code::IR_INVALID, "lock \"$lock\": want update, share, update_nowait or share_nowait");
        }
        if ($lock !== '' && ($isJoin || $isRelation || isset($q['group_by']) || isset($q['group_by_expr']) || ($q['limit_per_parent'] ?? 0) > 0)) {
            throw self::err(Code::IR_INVALID, 'row lock is only valid on a root row select');
        }
        $index = $q['force_index'] ?? '';
        if ($index !== '' && !array_key_exists($index, $ent['indexes'] ?? [])) {
            throw self::err(Code::INDEX_UNKNOWN, "$entity.$index");
        }
    }

    private static function joinPath(string $path, string $rel): string
    {
        return $path === '' ? $rel : "$path/$rel";
    }

    private function group(array $ent, array $g, array $joined): void
    {
        foreach ($g['items'] ?? [] as $i => $it) {
            $n = 0;
            $conn = '';
            foreach (['pred', 'group', 'joined'] as $k) {
                if (isset($it[$k])) {
                    $n++;
                    $conn = $it[$k]['conn'] ?? '';
                }
            }
            if ($n !== 1) {
                throw self::err(Code::IR_INVALID, 'where item must be exactly one of pred/group/joined');
            }
            if ($conn !== '' && $conn !== 'and' && $conn !== 'or') {
                throw self::err(Code::IR_INVALID, "conn \"$conn\"");
            }
            if ($i === 0 && $conn === 'or') {
                throw self::err(Code::OR_AT_GROUP_START, 'a group may not start with OR');
            }
            if (isset($it['joined'])) {
                $name = $it['joined']['join'] ?? '';
                $j = $joined[$name] ?? throw self::err(Code::ENTITY_NOT_JOINED, "$name is not joined in this statement");
                if (($j['query']['where']['items'] ?? []) === []) {
                    throw self::err(Code::IR_INVALID, "joined $name has no conditions");
                }
            } elseif (isset($it['pred'])) {
                $this->pred($ent, $it['pred']);
            } else {
                if (($it['group']['items'] ?? []) === []) {
                    throw self::err(Code::IR_INVALID, 'empty group');
                }
                $this->group($ent, $it['group'], $joined);
            }
        }
    }

    private function pred(array $ent, array $p): void
    {
        $this->params($p['ps'] ?? []);
        if (isset($p['p'])) {
            $this->params([$p['p']]);
        }
        $name = $ent['name'];
        $column = $p['column'] ?? '';
        $op = $p['op'] ?? '';
        if (($p['expr'] ?? '') !== '') {
            if ($column !== '' || $op !== '') {
                throw self::err(Code::IR_INVALID, 'expr pred may not carry column/op');
            }
            return;
        }
        if ($op === 'tuple_in' || $op === 'tuple_not_in') {
            $cols = $p['cols'] ?? [];
            if (count($cols) < 2) {
                throw self::err(Code::IR_INVALID, "$op needs at least two columns");
            }
            foreach ($cols as $c) {
                $col = Manifest::column($ent, $c) ?? throw self::err(Code::COLUMN_UNKNOWN, "$name.$c");
                if (($col['styles'] ?? []) !== [] || $col['type'] === 'json' || $col['type'] === 'point') {
                    throw self::err(Code::OPERATOR_NOT_ALLOWED, "$op on $name.$c");
                }
            }
            $ps = $p['ps'] ?? [];
            if ($ps === []) {
                throw self::err(Code::EMPTY_IN, "$name(" . implode(',', $cols) . ')');
            }
            if (count($ps) % count($cols) !== 0) {
                throw self::err(Code::IR_INVALID, sprintf('%s: %d values for %d columns', $op, count($ps), count($cols)));
            }
            return;
        }
        if (($p['cols'] ?? []) !== []) {
            throw self::err(Code::IR_INVALID, 'cols is only valid with tuple_in or tuple_not_in');
        }
        if (isset($p['sub'])) {
            if (Manifest::column($ent, $column) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "$name.$column");
            }
            if ($op !== 'in' && $op !== 'not_in') {
                throw self::err(Code::IR_INVALID, 'subquery needs in or not_in');
            }
            if (isset($p['p']) || ($p['ps'] ?? []) !== [] || isset($p['fn']) || isset($p['value'])) {
                throw self::err(Code::IR_INVALID, 'subquery pred may not carry values');
            }
            $this->sub($p['sub'], false);
            return;
        }
        if (isset($p['fn']) || isset($p['value'])) {
            $c = Manifest::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "$name.$column");
            if (isset($p['fn']) && isset($p['value'])) {
                throw self::err(Code::IR_INVALID, 'fn and value cannot be combined');
            }
            if (isset($p['fn'])) {
                $this->columnFunc($ent, $c, $p['fn']);
                if (in_array($op, self::CMP, true)) {
                    if (!isset($p['p'])) {
                        throw self::err(Code::IR_INVALID, "$op needs a value (p)");
                    }
                } elseif ($op === 'in' || $op === 'not_in') {
                    if (($p['ps'] ?? []) === []) {
                        throw self::err(Code::EMPTY_IN, "$name.$column");
                    }
                } elseif ($op === 'between') {
                    if (count($p['ps'] ?? []) !== 2) {
                        throw self::err(Code::IR_INVALID, 'between needs 2 params (ps)');
                    }
                } else {
                    throw self::err(Code::OPERATOR_NOT_ALLOWED, "$op with a column function");
                }
                return;
            }
            $fn = $p['value']['name'] ?? '';
            if (!Dialect::isValueFunction($fn)) {
                throw self::err(Code::FUNCTION_UNKNOWN, $fn);
            }
            if ($c['type'] !== 'date' && $c['type'] !== 'datetime') {
                throw self::err(Code::OPERATOR_NOT_ALLOWED, "$fn on $name.$column ({$c['type']})");
            }
            $want = isset(Dialect::VALUE_FUNCTION_UNITS[$fn]) ? 1 : 0;
            if (count($p['value']['ps'] ?? []) !== $want) {
                throw self::err(Code::IR_INVALID, "$fn takes $want arguments");
            }
            if (isset($p['p']) || ($p['ps'] ?? []) !== []) {
                throw self::err(Code::IR_INVALID, 'value function pred may not carry p or ps');
            }
            if (!in_array($op, self::CMP, true)) {
                throw self::err(Code::OPERATOR_NOT_ALLOWED, "$op with a value function");
            }
            $this->params($p['value']['ps'] ?? []);
            return;
        }
        if ($op === 'match' || $op === 'match_boolean') {
            $match = $p['match'] ?? [];
            if ($match === []) {
                throw self::err(Code::IR_INVALID, 'match needs columns');
            }
            if (!in_array($match, $ent['fulltext'] ?? [], true)) {
                throw self::err(Code::INDEX_UNKNOWN, "no fulltext index on $name(" . implode(',', $match) . ')');
            }
            if (!isset($p['p'])) {
                throw self::err(Code::IR_INVALID, 'match needs a value (p)');
            }
            return;
        }
        $c = Manifest::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "$name.$column");
        if (!self::opAllowed($c, $op)) {
            throw self::err(Code::OPERATOR_NOT_ALLOWED, "$op on $name.$column ({$c['type']})");
        }
        switch ($op) {
            case 'is_null':
            case 'is_not_null':
                return;
            case 'in':
            case 'not_in':
                if (($p['ps'] ?? []) === []) {
                    throw self::err(Code::EMPTY_IN, "$name.$column");
                }
                return;
            case 'between':
                if (count($p['ps'] ?? []) !== 2) {
                    throw self::err(Code::IR_INVALID, 'between needs 2 params (ps)');
                }
                return;
        }
        if (in_array($op, self::COL_OPS, true)) {
            if (!isset($p['ref'])) {
                throw self::err(Code::IR_INVALID, "$op needs ref");
            }
            return;
        }
        if (!isset($p['p'])) {
            throw self::err(Code::IR_INVALID, "$op $name.$column needs a value (p)");
        }
    }

    private function columnFunc(array $ent, array $c, array $f): void
    {
        $fn = $f['name'] ?? '';
        $types = Dialect::COLUMN_FUNCTION_TYPES[$fn] ?? throw self::err(Code::FUNCTION_UNKNOWN, $fn);
        if (!in_array($c['type'], $types, true)) {
            throw self::err(Code::OPERATOR_NOT_ALLOWED, "$fn on {$ent['name']}.{$c['name']} ({$c['type']})");
        }
        if (count($f['ps'] ?? []) !== Dialect::COLUMN_FUNCTION_ARITY[$fn]) {
            throw self::err(Code::IR_INVALID, "$fn takes " . Dialect::COLUMN_FUNCTION_ARITY[$fn] . ' arguments');
        }
        $this->params($f['ps'] ?? []);
    }

    private function sub(array $s, bool $scalar): void
    {
        $q = $s['query'] ?? throw self::err(Code::IR_INVALID, 'subquery needs a query');
        $ent = $this->m->entities[$q['entity'] ?? ''] ?? throw self::err(Code::ENTITY_UNKNOWN, $q['entity'] ?? '');
        $agg = $s['agg'] ?? '';
        $column = $s['column'] ?? '';
        switch ($agg) {
            case '':
                if ($column === '') {
                    throw self::err(Code::IR_INVALID, 'subquery needs a column');
                }
                break;
            case 'sum':
            case 'avg':
                if (!$scalar) {
                    throw self::err(Code::IR_INVALID, "$agg subquery is only valid as a column");
                }
                $c = Manifest::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "{$ent['name']}.$column");
                if (!in_array($c['type'], self::NUMERIC, true)) {
                    throw self::err(Code::OPERATOR_NOT_ALLOWED, "$agg on {$ent['name']}.$column ({$c['type']})");
                }
                break;
            case 'count':
                if (!$scalar) {
                    throw self::err(Code::IR_INVALID, 'count subquery is only valid as a column');
                }
                break;
            default:
                throw self::err(Code::IR_INVALID, "subquery agg \"$agg\"");
        }
        if ($column !== '' && Manifest::column($ent, $column) === null) {
            throw self::err(Code::COLUMN_UNKNOWN, "{$ent['name']}.$column");
        }
        if (isset($q['limit']) || ($q['relations'] ?? []) !== [] || ($q['lock'] ?? '') !== '' || isset($q['columns'])) {
            throw self::err(Code::IR_INVALID, 'subquery may not use limit, relations, lock or columns');
        }
        $this->query($q, '', false, false);
    }

    private static function joinedRefs(array $g, array &$seen): void
    {
        foreach ($g['items'] ?? [] as $it) {
            if (isset($it['joined'])) {
                $name = $it['joined']['join'];
                if (isset($seen[$name])) {
                    throw self::err(Code::IR_INVALID, "joined $name is placed twice");
                }
                $seen[$name] = true;
            }
            if (isset($it['group'])) {
                self::joinedRefs($it['group'], $seen);
            }
        }
    }
}
