<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Dbspec\Meet;

/** Validates a request (docs/spec/protocol.md) against the runtime model. */
final class Validator
{
    public const IR_VERSION = 1;

    private const CMP = ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte'];
    private const ORDERED = ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'between', 'is_null',
        'is_not_null'];
    private const EQUALITY = ['eq', 'not_eq', 'in', 'not_in', 'is_null', 'is_not_null'];
    private const OPS_BY_TYPE = [
        'i16' => self::ORDERED, 'i32' => self::ORDERED, 'i64' => self::ORDERED, 'f64' => self::ORDERED,
        'decimal' => self::ORDERED,
        'date' => self::ORDERED, 'time' => self::ORDERED, 'datetime' => self::ORDERED,
        'varchar' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'contains_binary',
            'is_null', 'is_not_null'],
        'text' => ['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'contains_binary', 'is_null', 'is_not_null'],
        'uuid' => self::EQUALITY,
        'bool' => ['eq', 'not_eq', 'is_null', 'is_not_null'],
        'bytes' => self::EQUALITY,
    ];
    private const COL_OPS = ['eq_col', 'not_eq_col', 'gt_col', 'gte_col', 'lt_col', 'lte_col'];

    /** Field types of every record: int, string, bool, list<T>, map<T>, or a record name. */
    private const RECORDS = [
        'Request' => self::QUERY + [
            'ir_version' => 'int', 'manifest_hash' => 'string', 'kind' => 'string', 'load' => 'bool',
            'set' => 'list<Assign>',
            'on_duplicate' => 'list<Assign>', 'rows' => 'list<list<int>>', 'optimistic' => 'Optimist',
            'agg' => 'string', 'n_params' => 'int',
        ],
        'Query' => self::QUERY,
        'Columns' => ['mode' => 'string', 'add' => 'list<string>', 'remove' => 'list<string>',
            'fn' => 'map<ColFunc>', 'sub' => 'map<Sub>'],
        'Func' => ['name' => 'string', 'ps' => 'list<int>'],
        'ColFunc' => ['column' => 'string', 'fn' => 'Func'],
        'Sub' => ['query' => 'Query', 'column' => 'string', 'agg' => 'string'],
        'Join' => ['rel' => 'string', 'kind' => 'string', 'query' => 'Query', 'left' => 'string', 'right' => 'string'],
        'Relation' => ['rel' => 'string', 'query' => 'Query', 'kind' => 'string', 'keys' => 'list<KeyPair>'],
        'KeyPair' => ['left' => 'string', 'right' => 'string'],
        'Group' => ['conn' => 'string', 'not' => 'bool', 'items' => 'list<Item>'],
        'Item' => ['pred' => 'Pred', 'group' => 'Group', 'joined' => 'JoinedRef'],
        'JoinedRef' => ['conn' => 'string', 'join' => 'string'],
        'Pred' => [
            'conn' => 'string', 'column' => 'string', 'op' => 'string', 'p' => 'int', 'ps' => 'list<int>',
            'ref' => 'ColRef', 'fn' => 'Func', 'value' => 'Func', 'cols' => 'list<string>', 'sub' => 'Sub',
        ],
        'ColRef' => ['path' => 'string', 'column' => 'string'],
        'Order' => ['column' => 'string', 'desc' => 'bool', 'random' => 'bool', 'fn' => 'Func'],
        'Limit' => ['offset' => 'int', 'count' => 'int'],
        'IfParent' => ['column' => 'string', 'p' => 'int'],
        'Assign' => ['column' => 'string', 'p' => 'int', 'null' => 'bool', 'plus_p' => 'int', 'minus_p' => 'int'],
        'Optimist' => ['column' => 'string', 'p' => 'int'],
    ];
    private const QUERY = [
        'entity' => 'string', 'columns' => 'Columns', 'on' => 'Group', 'where' => 'Group', 'joins' => 'list<Join>',
        'relations' => 'list<Relation>', 'order' => 'list<Order>', 'group_by' => 'list<string>',
        'limit' => 'Limit', 'force_index' => 'string', 'lock' => 'string', 'key_by' => 'string', 'flatten' => 'bool',
        'limit_per_parent' => 'int', 'if_parent' => 'IfParent', 'no_cascade_delete' => 'bool',
    ];

    private int $n = 0;

    public function __construct(private readonly RuntimeModel $m)
    {
    }

    private static function err(string $code, string $msg): OrmException
    {
        return new OrmException($code, $msg);
    }

    /**
     * Whether op is valid for the column's type and codec. An aes column compares equality by blind index,
     * a column with only hex and ip compares equality by its deterministic encoding,
     * and other codec columns compare only whether they are null.
     */
    public static function opAllowed(array $c, string $op): bool
    {
        if (in_array($op, self::COL_OPS, true)) {
            return true;
        }
        $codec = $c['codec'];
        if ($codec !== []) {
            if ($codec[0] === 'aes' || array_diff($codec, ['hex', 'ip']) === []) {
                return in_array($op, self::EQUALITY, true);
            }
            return $op === 'is_null' || $op === 'is_not_null';
        }
        return in_array($op, self::OPS_BY_TYPE[$c['type']], true);
    }

    public function validate(array $r): void
    {
        self::shape('Request', $r, '');
        if (($r['ir_version'] ?? 0) !== self::IR_VERSION) {
            throw self::err(
                Code::VERSION_MISMATCH,
                'ir_version ' . ($r['ir_version'] ?? 0) . ', engine ' . self::IR_VERSION
            );
        }
        if (($r['manifest_hash'] ?? '') !== $this->m->manifestHash) {
            throw self::err(
                Code::SCHEMA_HASH_MISMATCH,
                'client ' . ($r['manifest_hash'] ?? '') . ", engine {$this->m->manifestHash}"
            );
        }
        $kind = $r['kind'] ?? '';
        if (
            !in_array($kind, ['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate', 'insert', 'update',
            'delete', 'restore', 'restart_identity'], true)
        ) {
            throw self::err(Code::IR_INVALID, "unknown kind \"$kind\"");
        }
        // A table of an external document is written only by the set that owns it
        // (docs/spec/dbspec.md "External documents").
        $target = $this->m->entities[$r['entity'] ?? ''] ?? null;
        if (
            ($target['external'] ?? false)
            && in_array($kind, ['insert', 'update', 'delete', 'restore', 'restart_identity'], true)
        ) {
            throw self::err(Code::CONFIG, "{$target['table']} is owned by another document set");
        }
        if (($r['load'] ?? false) && ($kind !== 'insert' || ($r['on_duplicate'] ?? []) !== [])) {
            throw self::err(Code::IR_INVALID, 'load is only valid on insert without on_duplicate');
        }
        // restart_identity restarts only one entity's identity, so it takes no row or value.
        if (
            $kind === 'restart_identity' && (($r['set'] ?? []) !== [] || ($r['rows'] ?? []) !== []
            || ($r['on_duplicate'] ?? []) !== [] || isset($r['where']) || isset($r['optimistic']))
        ) {
            throw self::err(Code::IR_INVALID, 'restart_identity takes no set, rows, on_duplicate, where or optimistic');
        }
        $this->n = $r['n_params'] ?? 0;
        $root = $this->scopes($r);
        $this->query($r, ['root' => $root, 'outer' => null, 'node' => $root], false, false);
        if (($r['lock'] ?? '') !== '' && $kind !== 'one' && $kind !== 'all') {
            throw self::err(Code::IR_INVALID, 'row lock is only valid on one or all');
        }
        $entity = $r['entity'];
        $ent = $this->m->entities[$entity];
        if ($kind === 'sum' || $kind === 'avg') {
            $agg = $r['agg'] ?? '';
            $c = RuntimeModel::column($ent, $agg) ?? throw self::err(Code::COLUMN_UNKNOWN, "$entity.$agg");
            if (!RuntimeModel::numeric($c)) {
                throw self::err(Code::OPERATOR_NOT_ALLOWED, "$kind on $entity.$agg ({$c['type']})");
            }
        }
        if ($kind === 'group_count' && !self::hasGroupBy($r)) {
            throw self::err(Code::IR_INVALID, 'group_count needs group_by');
        }
        if (self::hasGroupBy($r) && $kind !== 'count' && $kind !== 'group_count') {
            throw self::err(Code::IR_INVALID, "group_by is only valid on count or group_count, not $kind");
        }
        $set = $r['set'] ?? [];
        if ($kind === 'insert' || $kind === 'update' || $kind === 'restore') {
            if ($set === [] && $kind !== 'restore') {
                throw self::err(Code::IR_INVALID, "$kind needs set[]");
            }
            foreach ($set as $a) {
                $this->assign($ent, $a);
                // A VALUES list has no current row for plus_p or minus_p to read; on_duplicate does.
                if ($kind === 'insert' && (isset($a['plus_p']) || isset($a['minus_p']))) {
                    throw self::err(Code::IR_INVALID, "insert cannot assign {$a['column']} by plus or minus");
                }
                // The key is the table's own. A restore checks its set with its key below.
                if ($kind === 'update') {
                    $c = RuntimeModel::column($ent, $a['column']);
                    if ($c['pk'] || $ent['identity'] === $a['column']) {
                        throw self::err(Code::IR_INVALID, 'cannot update ' . $a['column']);
                    }
                }
            }
        }
        $rows = $r['rows'] ?? [];
        if ($rows !== []) {
            if ($kind !== 'insert' || ($r['on_duplicate'] ?? []) !== []) {
                throw self::err(Code::IR_INVALID, 'rows are only valid on insert without on_duplicate');
            }
            foreach ($set as $a) {
                if (!isset($a['p'])) {
                    throw self::err(
                        Code::IR_INVALID,
                        "multi-row insert assigns $entity.{$a['column']} without a value"
                    );
                }
            }
            foreach ($rows as $i => $row) {
                if (count($row) !== count($set)) {
                    throw self::err(
                        Code::IR_INVALID,
                        sprintf('insert row %d has %d values for %d columns', $i + 1, count($row), count($set))
                    );
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
                $c = RuntimeModel::column($ent, $a['column']);
                if ($c['pk']) {
                    throw self::err(Code::IR_INVALID, "on_duplicate cannot assign $entity.{$a['column']}");
                }
            }
            self::conflictKey($ent, $r['set'] ?? []);
        }
        if (isset($r['optimistic'])) {
            $column = $r['optimistic']['column'] ?? '';
            if (RuntimeModel::column($ent, $column) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "$entity.$column");
            }
            $this->params([$r['optimistic']['p'] ?? 0]);
        }
        if (($kind === 'update' || $kind === 'delete') && ($r['where']['items'] ?? []) === []) {
            throw self::err(Code::IR_INVALID, "$kind without where");
        }
        if ($kind === 'restore') {
            // restore fixes only deleted rows, so there is no read version to compare with.
            if (isset($r['optimistic'])) {
                throw self::err(Code::IR_INVALID, 'restore takes no optimistic');
            }
            self::restoreKey($ent, $r);
        }
    }

    /**
     * The parts of the statement of a restore request (docs/spec/protocol.md 1.5), picked after the request
     * hook. The set values with a parameter and the eq conditions with a parameter that the where joins with
     * and give columns their values; the key is the primary key when they cover it, otherwise the first
     * unique key in name order that they cover. A set value of a key column becomes a condition, every other
     * set value is a new value, and the where keeps its other conditions, which narrow the restore further;
     * the key still names at most one row.
     *
     * @return array{key: list<string>, where: array{items: list<array<string, mixed>>},
     *     set: list<array<string, mixed>>} the key, the where with an eq condition for each set value of a
     *     key column, and the new values
     */
    public static function restoreKey(array $ent, array $r): array
    {
        if ($ent['soft_delete'] === '') {
            throw self::err(Code::IR_INVALID, "restore of {$ent['entity']}, which has no soft_delete setting");
        }
        $items = $r['where']['items'] ?? [];
        $valued = [];
        foreach ($items as $i => $item) {
            $conn = ($item['pred'] ?? $item['group'] ?? $item['joined'] ?? [])['conn'] ?? '';
            if ($i > 0 && $conn === 'or') {
                throw self::err(
                    Code::IR_INVALID,
                    "restore of {$ent['entity']} joins the conditions of its where with and"
                );
            }
            $pr = $item['pred'] ?? null;
            if (
                $pr !== null && ($pr['op'] ?? '') === 'eq' && isset($pr['p']) && !isset($pr['fn'])
                && !isset($pr['value']) && !isset($pr['ref']) && !isset($pr['sub'])
            ) {
                $valued[$pr['column']] = true;
            }
        }
        $set = $r['set'] ?? [];
        foreach ($set as $a) {
            if (isset($a['p'])) {
                $valued[$a['column']] = true;
            }
        }
        $covered = static function (array $columns) use ($valued): bool {
            foreach ($columns as $column) {
                if (!isset($valued[$column])) {
                    return false;
                }
            }
            return $columns !== [];
        };
        $key = null;
        if ($covered($ent['pk'])) {
            $key = $ent['pk'];
        } else {
            $unique = $ent['unique'];
            ksort($unique, SORT_STRING);
            foreach ($unique as $columns) {
                if ($covered($columns)) {
                    $key = $columns;
                    break;
                }
            }
        }
        if ($key === null) {
            throw self::err(
                Code::IR_INVALID,
                "restore of {$ent['entity']} gives no primary key or unique key a value in its set "
                . "or in an eq condition of its where"
            );
        }
        $parts = ['key' => $key, 'where' => ['items' => $items], 'set' => []];
        foreach ($set as $a) {
            if (isset($a['p']) && in_array($a['column'], $key, true)) {
                $pred = ['column' => $a['column'], 'op' => 'eq', 'p' => $a['p']];
                $parts['where']['items'][] = ['pred' =>
                    ($parts['where']['items'] === [] ? [] : ['conn' => 'and']) + $pred];
                continue;
            }
            // The key and the soft delete column are the table's own: a restore clears the latter itself.
            $c = RuntimeModel::column($ent, $a['column']);
            if ($c['pk'] || $ent['identity'] === $a['column'] || $a['column'] === $ent['soft_delete']) {
                throw self::err(Code::IR_INVALID, 'restore cannot assign ' . $a['column']);
            }
            $parts['set'][] = $a;
        }
        return $parts;
    }

    /**
     * The uses of each parameter of a validated request, by parameter index: each use is
     * ['type' => the slot's logical type, 'column' => the compared or assigned column or null].
     * A use is the compared or assigned column; a column function's result; i32, or f64 for
     * seconds, for the interval of a relative time function; text for contains and
     * contains_binary; the parent column for if_parent; the column for optimistic. An IR
     * executor message writes each parameter in the form of its slot's type
     * (docs/spec/protocol.md §5), so the client reads the type here.
     *
     * @return list<list<array{type: string, column: ?array}>>
     */
    public function paramUses(array $r): array
    {
        $out = array_fill(0, $r['n_params'] ?? 0, []);
        $ent = $this->m->entities[$r['entity']];
        $this->queryUses($r, null, $out);
        foreach ([...($r['set'] ?? []), ...($r['on_duplicate'] ?? [])] as $a) {
            $col = RuntimeModel::column($ent, $a['column']);
            foreach (['plus_p', 'minus_p'] as $field) {
                if (isset($a[$field])) {
                    self::columnUse($out, $a[$field], $col);
                }
            }
            if (isset($a['p']) && $col !== null) {
                self::addUse($out, $a['p'], $col['type'], $col, true);
            }
        }
        foreach ($r['rows'] ?? [] as $row) {
            foreach ($row as $j => $i) {
                $col = RuntimeModel::column($ent, $r['set'][$j]['column']);
                if ($col !== null) {
                    self::addUse($out, $i, $col['type'], $col, true);
                }
            }
        }
        if (isset($r['optimistic'])) {
            self::columnUse($out, $r['optimistic']['p'], RuntimeModel::column($ent, $r['optimistic']['column']));
        }
        return $out;
    }

    /**
     * The type of a column function's result on column $col: the type of a parameter compared with it and of
     * the output column it selects.
     */
    public static function functionType(string $name, ?array $col): string
    {
        return match ($name) {
            'day_of_week', 'year', 'month' => 'i64',
            'date' => 'date',
            default => $col['type'] ?? 'text',
        };
    }

    /** The type of the interval of a relative time function: seconds take a fraction, the other units an integer. */
    public static function intervalType(string $name): string
    {
        return (Dialect::VALUE_FUNCTION_UNITS[$name] ?? '') === 'second' ? 'f64' : 'i32';
    }

    /** @param list<list<array{type: string, column: ?array}>> $out */
    private static function addUse(array &$out, int $i, string $type, ?array $col, bool $assign = false): void
    {
        if ($i >= 0 && $i < count($out)) {
            $out[$i][] = ['type' => $type, 'column' => $col, 'assign' => $assign];
        }
    }

    /** @param list<list<array{type: string, column: ?array}>> $out */
    private static function columnUse(array &$out, int $i, ?array $col): void
    {
        if ($col !== null) {
            self::addUse($out, $i, $col['type'], $col);
        }
    }

    /**
     * Adds query $q's parameter uses to $out. The $parent of a relation child is the parent entity.
     *
     * @param list<list<array{type: string, column: ?array}>> $out
     */
    private function queryUses(array $q, ?array $parent, array &$out): void
    {
        $ent = $this->m->entities[$q['entity'] ?? ''] ?? null;
        if ($ent === null) {
            return;
        }
        $this->groupUses($q['on'] ?? null, $ent, $out);
        $this->groupUses($q['where'] ?? null, $ent, $out);
        if (isset($q['if_parent']) && $parent !== null) {
            self::columnUse($out, $q['if_parent']['p'], RuntimeModel::column($parent, $q['if_parent']['column']));
        }
        foreach ($q['columns']['sub'] ?? [] as $sub) {
            $this->queryUses($sub['query'], null, $out);
        }
        foreach ($q['joins'] ?? [] as $j) {
            $this->queryUses($j['query'], null, $out);
        }
        foreach ($q['relations'] ?? [] as $rel) {
            $this->queryUses($rel['query'], $ent, $out);
        }
    }

    /** @param list<list<array{type: string, column: ?array}>> $out */
    private function groupUses(?array $g, array $ent, array &$out): void
    {
        foreach ($g['items'] ?? [] as $item) {
            if (isset($item['pred'])) {
                $this->predUses($item['pred'], $ent, $out);
            } elseif (isset($item['group'])) {
                $this->groupUses($item['group'], $ent, $out);
            }
        }
    }

    /** @param list<list<array{type: string, column: ?array}>> $out */
    private function predUses(array $p, array $ent, array &$out): void
    {
        if (isset($p['sub'])) {
            $this->queryUses($p['sub']['query'], null, $out);
        }
        if ($p['op'] === 'tuple_in' || $p['op'] === 'tuple_not_in') {
            $cols = $p['cols'] ?? [];
            foreach ($p['ps'] ?? [] as $k => $i) {
                if ($cols !== []) {
                    self::columnUse($out, $i, RuntimeModel::column($ent, $cols[$k % count($cols)]));
                }
            }
            return;
        }
        if ($p['op'] === 'fulltext' || $p['op'] === 'fulltext_boolean') {
            if (isset($p['p'])) {
                self::addUse($out, $p['p'], 'text', null);
            }
            return;
        }
        $col = RuntimeModel::column($ent, $p['column'] ?? '');
        foreach ($p['value']['ps'] ?? [] as $i) {
            // The interval of a relative time function: seconds take a fraction, and other units take an integer.
            self::addUse($out, $i, self::intervalType($p['value']['name']), null);
        }
        if ($p['op'] === 'contains' || $p['op'] === 'contains_binary') {
            if (isset($p['p'])) {
                self::addUse($out, $p['p'], 'text', null);
            }
            return;
        }
        $slots = $p['ps'] ?? [];
        if (isset($p['p'])) {
            array_unshift($slots, $p['p']);
        }
        foreach ($slots as $i) {
            if (isset($p['fn'])) {
                $type = self::functionType($p['fn']['name'], $col);
                if ($col !== null && $type === $col['type']) {
                    self::columnUse($out, $i, $col);
                } else {
                    self::addUse($out, $i, $type, null);
                }
                continue;
            }
            self::columnUse($out, $i, $col);
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
        $c = RuntimeModel::column($ent, $column) ?? throw self::err(
            Code::COLUMN_UNKNOWN,
            "{$ent['entity']}.$column"
        );
        if ($column === $ent['audit']) {
            throw self::err(
                Code::IR_INVALID,
                "{$ent['entity']}.$column is written by the executor from the audit of the transaction"
            );
        }
        $n = (int) isset($a['p']) + (int) !empty($a['null']) + (int) isset($a['plus_p']) + (int) isset($a['minus_p']);
        if ($n !== 1) {
            throw self::err(Code::IR_INVALID, "set $column: exactly one of p/null/plus_p/minus_p");
        }
        if (!empty($a['null']) && !$c['nullable']) {
            throw self::err(Code::IR_INVALID, "set {$ent['entity']}.$column to null but column is NOT NULL");
        }
        if ((isset($a['plus_p']) || isset($a['minus_p'])) && !RuntimeModel::numeric($c)) {
            throw self::err(Code::OPERATOR_NOT_ALLOWED, "plus/minus on {$ent['entity']}.$column ({$c['type']})");
        }
        foreach (['p', 'plus_p', 'minus_p'] as $k) {
            if (isset($a[$k])) {
                $this->params([$a[$k]]);
            }
        }
    }

    private static function hasGroupBy(array $q): bool
    {
        return ($q['group_by'] ?? []) !== [];
    }

    /**
     * scopes is the scope tree of q and its joins (name, ent, joins). As in planner's buildScopes, all joins
     * are placed before conditions are checked, so a condition can also resolve the path of a join declared
     * later. The ent of an entity not in the manifest is null.
     */
    private function scopes(array $q): array
    {
        $entity = $q['entity'] ?? '';
        $s = ['name' => $entity, 'ent' => $this->m->entities[$entity] ?? null, 'joins' => []];
        foreach ($q['joins'] ?? [] as $j) {
            $rel = $j['rel'] ?? '';
            if (!isset($s['joins'][$rel]) && isset($j['query'])) {
                $s['joins'][$rel] = $this->scopes($j['query']);
            }
        }
        return $s;
    }

    /**
     * ref resolves a ref in a column-to-column condition as planner's resolvePath does. $at is the place
     * where the condition sits: root is the statement's root scope, outer is the scope of the query enclosing
     * a subquery (null if not a subquery), node is the scope of the condition. Path "" is root, "^" is outer
     * and is used only inside a subquery, and any other path is the join names joined with "/" from root.
     * The target entity must have the ref's column.
     */
    private function ref(array $at, array $ref): array
    {
        $path = $ref['path'] ?? '';
        $column = $ref['column'] ?? '';
        $target = $at['root'];
        if ($path === '^') {
            $target = $at['outer'] ?? throw self::err(Code::IR_INVALID, '^ reference outside a subquery');
        } elseif ($path !== '') {
            foreach (explode('/', $path) as $seg) {
                $target = $target['joins'][$seg] ?? throw self::err(Code::ENTITY_NOT_JOINED, "{$target['name']}.$seg");
            }
        }
        $ent = $target['ent'] ?? throw self::err(Code::ENTITY_UNKNOWN, $target['name']);
        return RuntimeModel::column($ent, $column) ?? throw self::err(
            Code::COLUMN_UNKNOWN,
            "{$target['name']}.$column"
        );
    }

    /**
     * The one key an insert with on_duplicate conflicts on. MySQL updates the row met on any unique key,
     * while PostgreSQL and SQLite name one target and a meeting on another key is a unique violation, so no
     * order of keys reproduces both: an upsert has exactly one key that can meet the inserted row, and the
     * insert assigns every column of it. The candidates are the primary key, unless the insert leaves it out
     * (an identity, or a key an IR executor assigns), and each unique key; a blind index column counts as
     * assigned with its AES source.
     *
     * @param list<array<string, mixed>> $set
     * @return list<string>
     */
    public static function conflictKey(array $ent, array $set): array
    {
        $assigned = array_fill_keys(array_column($set, 'column'), true);
        foreach ($ent['columns'] as $f) {
            if ($f['blind_index'] !== '' && isset($assigned[$f['name']])) {
                $assigned[$f['blind_index']] = true;
            }
        }
        $candidates = [];
        foreach ($ent['pk'] as $c) {
            if (isset($assigned[$c])) {
                $candidates[] = ['name' => 'primary key (' . implode(', ', $ent['pk']) . ')', 'columns' => $ent['pk']];
                break;
            }
        }
        foreach ($ent['unique'] as $u) {
            $candidates[] = ['name' => 'unique (' . implode(', ', $u) . ')', 'columns' => $u];
        }
        if ($candidates === []) {
            throw self::err(Code::IR_INVALID, 'on_duplicate needs exactly one conflict key; no key can meet the row');
        }
        if (count($candidates) !== 1) {
            throw self::err(Code::IR_INVALID, 'on_duplicate needs exactly one conflict key; '
                . implode(', ', array_column($candidates, 'name')) . ' can meet the row');
        }
        foreach ($candidates[0]['columns'] as $c) {
            if (!isset($assigned[$c])) {
                throw self::err(
                    Code::IR_INVALID,
                    "on_duplicate needs exactly one conflict key; {$candidates[0]['name']} can meet the row "
                    . "but the insert does not assign $c"
                );
            }
        }
        return $candidates[0]['columns'];
    }

    /**
     * Whether two columns compare alike on the three databases, by the table that dbspec's check operands
     * also read.
     */
    private static function meets(array $a, array $b): bool
    {
        return Meet::kind($a['type'], $a['scale'] ?? 0, $a['precision'] ?? 0)
            === Meet::kind($b['type'], $b['scale'] ?? 0, $b['precision'] ?? 0);
    }

    /**
     * Whether the column comparison $op may compare $left with $right: its base operator (eq for eq_col) must be one of
     * the left column's type, and neither column may have a codec, since a codec's stored form is not the value the
     * operator orders. Two columns whose only codec is ip compare by eq_col and not_eq_col, because both sides are the
     * dialect's same stored form.
     */
    private static function colPairOpAllowed(array $left, array $right, string $op): bool
    {
        $base = substr($op, 0, -4);
        if ($left['codec'] === [] && $right['codec'] === []) {
            return in_array($base, self::OPS_BY_TYPE[$left['type']], true);
        }
        return $left['codec'] === ['ip'] && $right['codec'] === ['ip'] && ($base === 'eq' || $base === 'not_eq');
    }

    /** query checks q. $at is the place in q (see ref). */
    private function query(array $q, array $at, bool $isJoin, bool $isRelation): void
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
                if (RuntimeModel::column($ent, $c) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "$entity.$c");
                }
            }
            $outputs = [];
            foreach ($cols['fn'] ?? [] as $out => $cf) {
                $out = (string) $out;
                if (RuntimeModel::column($ent, $out) !== null || isset($outputs[$out])) {
                    throw self::err(Code::COLUMN_ALIAS_CONFLICT, "$entity.$out is already a row name");
                }
                $outputs[$out] = true;
                $col = RuntimeModel::column($ent, $cf['column'] ?? '') ?? throw self::err(
                    Code::COLUMN_UNKNOWN,
                    "$entity." . ($cf['column'] ?? '')
                );
                $this->columnFunc($ent, $col, $cf['fn'] ?? []);
            }
            foreach ($cols['sub'] ?? [] as $out => $sub) {
                $out = (string) $out;
                if (RuntimeModel::column($ent, $out) !== null || isset($outputs[$out])) {
                    throw self::err(Code::COLUMN_ALIAS_CONFLICT, "$entity.$out is already a row name");
                }
                $outputs[$out] = true;
                $this->sub($sub, true, $at['node']);
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
            // A join is made only on the two columns that the match method picks. No relation is inferred from names.
            if ($left === '' || $right === '' || !isset($j['query'])) {
                throw self::err(Code::IR_INVALID, "join $rel: left, right and query are required");
            }
            $target = $this->m->entities[$j['query']['entity'] ?? ''] ?? throw self::err(
                Code::ENTITY_UNKNOWN,
                $j['query']['entity'] ?? ''
            );
            if (RuntimeModel::column($ent, $left) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "{$ent['entity']}.$left");
            }
            if (RuntimeModel::column($target, $right) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "{$target['entity']}.$right");
            }
            if (!self::meets(RuntimeModel::column($ent, $left), RuntimeModel::column($target, $right))) {
                throw self::err(
                    Code::OPERATOR_NOT_ALLOWED,
                    "join $rel: {$ent['entity']}.$left does not meet {$target['entity']}.$right"
                );
            }
            $joined[$rel] = $j;
            $this->query($j['query'], ['root' => $at['root'], 'outer' => $at['outer'],
                'node' => $at['node']['joins'][$rel]], true, false);
        }
        if (!$isJoin && isset($q['on'])) {
            throw self::err(Code::IR_INVALID, 'on[] is only valid on join children');
        }
        if (!empty($q['on']['not']) || !empty($q['where']['not'])) {
            throw self::err(Code::IR_INVALID, 'not applies to a nested group');
        }
        // The top-level group has no earlier sibling, so it has no conn.
        foreach (['on', 'where'] as $top) {
            if (($q[$top]['conn'] ?? '') !== '') {
                throw self::err(Code::IR_INVALID, "the top-level group takes no conn (\"{$q[$top]['conn']}\")");
            }
        }
        if (isset($q['on'])) {
            $this->group($at, $q['on'], $joined);
        }
        if (isset($q['where'])) {
            $this->group($at, $q['where'], $joined);
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
            if (RuntimeModel::column($ent, $rel) !== null) {
                throw self::err(Code::COLUMN_ALIAS_CONFLICT, "$entity.$rel is already a column");
            }
            $child = $r['query'] ?? throw self::err(Code::IR_INVALID, "relation $rel needs a query");
            $kind = $r['kind'] ?? '';
            $keys = $r['keys'] ?? [];
            if ($keys === [] || ($kind !== 'one' && $kind !== 'many')) {
                throw self::err(Code::IR_INVALID, "relation $rel: keys and kind one|many are required");
            }
            $target = $this->m->entities[$child['entity'] ?? ''] ?? throw self::err(
                Code::ENTITY_UNKNOWN,
                $child['entity'] ?? ''
            );
            $lefts = [];
            $rights = [];
            foreach ($keys as $k) {
                $left = $k['left'] ?? '';
                $right = $k['right'] ?? '';
                if ($left === '' || $right === '') {
                    throw self::err(Code::IR_INVALID, "relation $rel: every key needs left and right");
                }
                if (RuntimeModel::column($ent, $left) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "$entity.$left");
                }
                if (RuntimeModel::column($target, $right) === null) {
                    throw self::err(Code::COLUMN_UNKNOWN, "{$target['entity']}.$right");
                }
                if (!self::meets(RuntimeModel::column($ent, $left), RuntimeModel::column($target, $right))) {
                    throw self::err(
                        Code::OPERATOR_NOT_ALLOWED,
                        "relation $rel: $entity.$left does not meet {$target['entity']}.$right"
                    );
                }
                // A column that appears in two components is not a key.
                if (isset($lefts[$left]) || isset($rights[$right])) {
                    throw self::err(Code::IR_INVALID, "relation $rel: key column $left or $right is used twice");
                }
                $lefts[$left] = true;
                $rights[$right] = true;
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
            if (
                isset($child['if_parent'])
                && RuntimeModel::column($ent, $child['if_parent']['column'] ?? '') === null
            ) {
                throw self::err(
                    Code::COLUMN_UNKNOWN,
                    "$entity." . ($child['if_parent']['column'] ?? '') . ' (if_parent)'
                );
            }
            $scope = $this->scopes($child);
            $this->query($child, ['root' => $scope, 'outer' => null, 'node' => $scope], false, true);
        }
        $keyBy = $q['key_by'] ?? '';
        if ($keyBy !== '') {
            $keyColumn = RuntimeModel::column($ent, $keyBy) ?? throw self::err(Code::COLUMN_UNKNOWN, "$entity.$keyBy");
            // A NULL collection key has no answer that every language shares.
            if ($keyColumn['nullable']) {
                throw self::err(Code::IR_INVALID, "key_by $keyBy is nullable");
            }
        }
        if (isset($q['if_parent'])) {
            $this->params([$q['if_parent']['p'] ?? 0]);
        }
        if (
            !$isRelation && ($keyBy !== '' || !empty($q['flatten']) || ($q['limit_per_parent'] ?? 0) > 0
            || isset($q['if_parent']) || !empty($q['no_cascade_delete']))
        ) {
            throw self::err(Code::IR_INVALID, "relation-only options on $entity");
        }
        foreach ($q['order'] ?? [] as $o) {
            $column = $o['column'] ?? '';
            $kinds = (int) ($column !== '') + (int) !empty($o['random']);
            if ($kinds !== 1) {
                throw self::err(Code::IR_INVALID, 'order needs exactly one of column, random');
            }
            if ($column !== '') {
                $col = RuntimeModel::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "$entity.$column");
                if (isset($o['fn'])) {
                    $this->columnFunc($ent, $col, $o['fn']);
                }
            } elseif (isset($o['fn'])) {
                throw self::err(Code::IR_INVALID, 'order function needs a column');
            }
        }
        foreach ($q['group_by'] ?? [] as $g) {
            if (RuntimeModel::column($ent, $g) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "$entity.$g");
            }
        }
        if (self::hasGroupBy($q)) {
            // The request's own query is the only one that may group: a join, a relation and a subquery have an outer.
            if ($isJoin || $isRelation || $at['outer'] !== null) {
                throw self::err(Code::IR_INVALID, "group_by is only valid on the request's root query");
            }
            // An order item of a grouped query sorts the groups: only a group column (or random) has a value per group.
            foreach ($q['order'] ?? [] as $o) {
                if (($o['column'] ?? '') !== '' && !in_array($o['column'], $q['group_by'], true)) {
                    throw self::err(Code::IR_INVALID, "order by {$o['column']}, which is not a group column");
                }
            }
        }
        if (isset($q['limit']) && (($q['limit']['offset'] ?? 0) < 0 || ($q['limit']['count'] ?? 0) <= 0)) {
            throw self::err(Code::IR_INVALID, 'limit offset>=0, count>0');
        }
        $lock = $q['lock'] ?? '';
        if ($lock !== '' && !in_array($lock, ['update', 'share', 'update_nowait', 'share_nowait'], true)) {
            throw self::err(Code::IR_INVALID, "lock \"$lock\": want update, share, update_nowait or share_nowait");
        }
        if ($lock !== '' && ($isJoin || $isRelation || isset($q['group_by']) || ($q['limit_per_parent'] ?? 0) > 0)) {
            throw self::err(Code::IR_INVALID, 'row lock is only valid on a root row select');
        }
        $index = $q['force_index'] ?? '';
        if ($index !== '' && !array_key_exists($index, $ent['indexes'])) {
            throw self::err(Code::INDEX_UNKNOWN, "$entity.$index");
        }
    }

    private function group(array $at, array $g, array $joined): void
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
            // The first item of a group has no earlier sibling, so it has no conn.
            if ($i === 0 && $conn !== '') {
                throw self::err(Code::IR_INVALID, "the first item of a group takes no conn (\"$conn\")");
            }
            if (isset($it['joined'])) {
                $name = $it['joined']['join'] ?? '';
                $j = $joined[$name] ?? throw self::err(
                    Code::ENTITY_NOT_JOINED,
                    "$name is not joined in this statement"
                );
                if (($j['query']['where']['items'] ?? []) === []) {
                    throw self::err(Code::IR_INVALID, "joined $name has no conditions");
                }
            } elseif (isset($it['pred'])) {
                $this->pred($at, $it['pred']);
            } else {
                if (($it['group']['items'] ?? []) === []) {
                    throw self::err(Code::IR_INVALID, 'empty group');
                }
                $this->group($at, $it['group'], $joined);
            }
        }
    }

    private function pred(array $at, array $p): void
    {
        $ent = $at['node']['ent'];
        $this->params($p['ps'] ?? []);
        if (isset($p['p'])) {
            $this->params([$p['p']]);
        }
        $name = $ent['entity'];
        $column = $p['column'] ?? '';
        $op = $p['op'] ?? '';
        if ($op === 'tuple_in' || $op === 'tuple_not_in') {
            $cols = $p['cols'] ?? [];
            if (count($cols) < 2) {
                throw self::err(Code::IR_INVALID, "$op needs at least two columns");
            }
            foreach ($cols as $c) {
                $col = RuntimeModel::column($ent, $c) ?? throw self::err(Code::COLUMN_UNKNOWN, "$name.$c");
                if ($col['codec'] !== []) {
                    throw self::err(Code::OPERATOR_NOT_ALLOWED, "$op on $name.$c");
                }
            }
            $ps = $p['ps'] ?? [];
            if ($ps === []) {
                throw self::err(Code::EMPTY_IN, "$name(" . implode(',', $cols) . ')');
            }
            if (count($ps) % count($cols) !== 0) {
                throw self::err(
                    Code::IR_INVALID,
                    sprintf('%s: %d values for %d columns', $op, count($ps), count($cols))
                );
            }
            return;
        }
        if ($op === 'fulltext' || $op === 'fulltext_boolean') {
            $cols = $p['cols'] ?? [];
            if (
                $cols === [] || !isset($p['p']) || $column !== '' || (
                $p['ps'] ?? []
                ) !== [] || isset($p['sub']) || isset($p['fn']) || isset($p['value']) || isset($p['ref'])
            ) {
                throw self::err(Code::IR_INVALID, "$op takes cols and p only");
            }
            foreach ($cols as $c) {
                $col = RuntimeModel::column($ent, $c) ?? throw self::err(Code::COLUMN_UNKNOWN, "$name.$c");
                if (!in_array($col['type'], ['varchar', 'text'], true) || $col['codec'] !== []) {
                    throw self::err(Code::OPERATOR_NOT_ALLOWED, "$op on $name.$c");
                }
            }
            return;
        }
        if (($p['cols'] ?? []) !== []) {
            throw self::err(Code::IR_INVALID, 'cols is only valid with tuple_in or tuple_not_in');
        }
        if (isset($p['sub'])) {
            if (RuntimeModel::column($ent, $column) === null) {
                throw self::err(Code::COLUMN_UNKNOWN, "$name.$column");
            }
            if ($op !== 'in' && $op !== 'not_in') {
                throw self::err(Code::IR_INVALID, 'subquery needs in or not_in');
            }
            if (isset($p['p']) || ($p['ps'] ?? []) !== [] || isset($p['fn']) || isset($p['value'])) {
                throw self::err(Code::IR_INVALID, 'subquery pred may not carry values');
            }
            $this->sub($p['sub'], false, $at['node']);
            // sub checked the subquery column; it meets the compared column as check operands do.
            $subEntity = $this->m->entities[$p['sub']['query']['entity']];
            $subColumn = RuntimeModel::column($subEntity, $p['sub']['column'] ?? '');
            if ($subColumn !== null && !self::meets(RuntimeModel::column($ent, $column), $subColumn)) {
                throw self::err(
                    Code::OPERATOR_NOT_ALLOWED,
                    "$name.$column does not meet the subquery column "
                    . "{$p['sub']['query']['entity']}.{$p['sub']['column']}"
                );
            }
            return;
        }
        if (isset($p['fn']) || isset($p['value'])) {
            $c = RuntimeModel::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "$name.$column");
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
            if ($c['codec'] !== [] || ($c['type'] !== 'date' && $c['type'] !== 'datetime')) {
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
        $c = RuntimeModel::column($ent, $column) ?? throw self::err(Code::COLUMN_UNKNOWN, "$name.$column");
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
            $other = $this->ref($at, $p['ref']);
            if (!self::meets($c, $other)) {
                throw self::err(
                    Code::OPERATOR_NOT_ALLOWED,
                    "$name.$column does not meet {$p['ref']['column']}"
                );
            }
            if (!self::colPairOpAllowed($c, $other, $op)) {
                throw self::err(
                    Code::OPERATOR_NOT_ALLOWED,
                    "$op on $name.$column ({$c['type']}) and {$p['ref']['column']} ({$other['type']})"
                );
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
        if ($c['codec'] !== [] || !in_array($c['type'], $types, true)) {
            throw self::err(Code::OPERATOR_NOT_ALLOWED, "$fn on {$ent['entity']}.{$c['name']} ({$c['type']})");
        }
        if (count($f['ps'] ?? []) !== Dialect::COLUMN_FUNCTION_ARITY[$fn]) {
            throw self::err(Code::IR_INVALID, "$fn takes " . Dialect::COLUMN_FUNCTION_ARITY[$fn] . ' arguments');
        }
        $this->params($f['ps'] ?? []);
    }

    /** sub checks a subquery. $outer is the scope the subquery sits in, and its "^" ref points there. */
    private function sub(array $s, bool $scalar, array $outer): void
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
                $c = RuntimeModel::column($ent, $column) ??
                throw self::err(Code::COLUMN_UNKNOWN, "{$ent['entity']}.$column");
            if (!RuntimeModel::numeric($c)) {
                throw self::err(Code::OPERATOR_NOT_ALLOWED, "$agg on {$ent['entity']}.$column ({$c['type']})");
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
        if ($column !== '' && RuntimeModel::column($ent, $column) === null) {
            throw self::err(Code::COLUMN_UNKNOWN, "{$ent['entity']}.$column");
        }
        // A scalar column subquery yields at most one row by its shape: MySQL answers 1242 and PostgreSQL 21000
        // for several rows, and SQLite returns the first, so the request makes one row certain. An in subquery
        // (MySQL 1235) and an aggregate take no limit.
        $scalarColumn = $scalar && $agg === '';
        if (
            ($q['relations'] ?? []) !== [] || ($q['lock'] ?? '') !== '' || isset($q['columns'])
            || (isset($q['limit']) && !$scalarColumn)
        ) {
            throw self::err(Code::IR_INVALID, 'subquery may not use limit, relations, lock or columns');
        }
        if ($scalarColumn) {
            if (!isset($q['limit']) || ($q['limit']['count'] ?? 0) !== 1) {
                throw self::err(Code::IR_INVALID, 'a scalar column subquery needs limit with count 1');
            }
            $order = $q['order'] ?? [];
            foreach ($order as $o) {
                if (!empty($o['random'])) {
                    throw self::err(Code::IR_INVALID, 'a scalar column subquery may not order by random');
                }
            }
            foreach ($ent['pk'] as $pk) {
                $found = false;
                foreach ($order as $o) {
                    if (($o['column'] ?? '') === $pk && !isset($o['fn'])) {
                        $found = true;
                    }
                }
                if (!$found) {
                    throw self::err(
                        Code::IR_INVALID,
                        "a scalar column subquery needs an order that includes the primary key column $pk"
                    );
                }
            }
        }
        $scope = $this->scopes($q);
        $this->query($q, ['root' => $scope, 'outer' => $outer, 'node' => $scope], false, false);
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
