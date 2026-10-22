<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal The markdown IR executor client (docs/spec/protocol.md §5): a markdown connection sends
 * each validated request as one message to a flowmark server and assembles the rows it answers.
 * It plans nothing and sends no SQL.
 */
final class Markdown
{
    /**
     * The error that the SQL-only surface accepts on a markdown connection (docs/spec/dialects.md "Markdown
     * IR executor").
     */
    /**
     * The begin control message of a transaction: a read-only transaction sends read_only true, any other
     * leaves the member out (docs/spec/protocol.md §5 Session, the control cases of tests/bind/vectors.json).
     *
     * @return array{op: 'begin', read_only?: true}
     */
    public static function beginMessage(bool $readOnly): array
    {
        return $readOnly ? ['op' => 'begin', 'read_only' => true] : ['op' => 'begin'];
    }

    public static function unsupported(string $surface): OrmException
    {
        return new OrmException(
            Code::CAPABILITY_UNSUPPORTED,
            "$surface is not supported by the markdown IR executor"
        );
    }

    private static function answerError(string $message): OrmException
    {
        return new OrmException(Code::INTERNAL, 'the flowmark answer: ' . $message);
    }

    /**
     * Validates r, runs its request message on the connection's session, and returns the answer and the
     * runtime model.
     * The message is {ir_version, manifest_hash, request, params, now}.
     *
     * @return array{0: array<string, mixed>, 1: RuntimeModel}
     */
    private static function call(Db $db, Request $r): array
    {
        $model = $db->registeredModel($r->ir['manifest_hash']);
        $request = $r->shape();
        $validator = new Validator($model);
        $validator->validate($request);
        $uses = $validator->paramUses($request);
        foreach ($r->params as $i => $v) {
            foreach ($uses[$i] ?? [] as $use) {
                ParamCheck::checkAssign($i, $v, ParamCheck::useSlotType($use));
                if (
                    $use['column'] !== null && array_filter(
                        $use['column']['codec'],
                        static fn(string $s): bool => Codec::isHostStyle($s)
                    ) !== []
                ) {
                    continue;
                }
                ParamCheck::check($i, $v, ParamCheck::useSlotType($use), $db->zone());
            }
        }
        $params = [];
        foreach ($r->params as $i => $v) {
            $params[] = self::param($db, $i, $v, $uses[$i] ?? []);
        }
        $message = [
            'ir_version' => $request['ir_version'],
            'manifest_hash' => $request['manifest_hash'],
            'request' => $request,
            'params' => $params,
            'now' => $db->clock()->format('Y-m-d H:i:s.u'),
        ];
        return [$db->markdownSession()->call($message), $model];
    }

    /**
     * The runtime value model JSON value of parameter $i: a decimal is a string, bytes are base64, and a
     * datetime is YYYY-MM-DD HH:MM:SS.ffffff in UTC, a date is YYYY-MM-DD, a time is HH:MM:SS.ffffff
     * (digits after p are 0; string values too). Which form it is is decided by the type of the slot the
     * parameter fills. For a hex or ip style column's slot, the client encodes the value before sending it,
     * as on an SQL connection.
     *
     * @param list<array{type: string, column: ?array}> $uses
     */
    private static function param(Db $db, int $i, mixed $v, array $uses): mixed
    {
        $use = $uses[0] ?? ['type' => '', 'column' => null];
        $col = $use['column'];
        if ($col !== null && $v !== null) {
            $host = array_values(array_filter($col['codec'], static fn(string $s): bool => Codec::isHostStyle($s)));
            if ($host !== []) {
                $v = Codec::hostEncode($v, $host, $db->config()->aesKey);
            }
        }
        if ($v instanceof \DateTimeInterface) {
            $t = \DateTimeImmutable::createFromInterface($v)->setTimezone($db->zone());
            return match ($use['type']) {
                'date' => $t->format('Y-m-d'),
                'time' => $t->format('H:i:s.u'),
                default => $t->format('Y-m-d H:i:s.u'),
            };
        }
        if ($v instanceof Bytes) {
            return base64_encode($v->bytes);
        }
        if (is_string($v) && in_array($use['type'], ['date', 'time', 'datetime'], true)) {
            return Db::timeValue($v, $use['type'], 6, $db->zone());
        }
        if (is_string($v) && $use['type'] === 'bytes') {
            return base64_encode($v);
        }
        if ($v !== null && !is_scalar($v)) {
            throw new OrmException(Code::CODEC_ENCODE, "parameter $i (" . get_debug_type($v) . ') has no JSON form');
        }
        return $v;
    }

    /**
     * Reads the answer of row reads (one, all, group_count, paginate) as a plan and a positional result.
     * The plan is one placement of the root node; the last cell of each row in the result is that row's
     * join and relation rows (MarkdownLinks).
     * The third value of paginate is the number of all rows that match the condition.
     *
     * @return array{0: array, 1: array, 2: int}
     */
    public static function read(Db $db, Request $r): array
    {
        [$answer, $model] = self::call($db, $r);
        $kind = $r->ir['kind'];
        $rows = $answer['rows'] ?? null;
        if (!is_array($rows) || !array_is_list($rows)) {
            throw self::answerError("a $kind answer has no rows");
        }
        $count = $answer['count'] ?? null;
        if ($kind === 'paginate' && !is_int($count)) {
            throw self::answerError('a paginate answer has no count');
        }
        $groups = $kind === 'group_count';
        $plan = ['kind' => $kind, 'steps' => [['role' => 'main',
            'assemble' => self::layout($model, $r->ir, $groups, $rows)]]];
        Assemble::index($plan, $model);
        $main = self::rows($db->config(), $model, $r->ir, $plan['steps'][0]['assemble'], $rows);
        return [$plan, ['main' => $main, 'steps' => [], 'params' => $r->params, 'markdown' => true],
            is_int($count) ? $count : 0];
    }

    /** The answer for count, sum, and avg. */
    public static function scalar(Db $db, Request $r): mixed
    {
        [$answer] = self::call($db, $r);
        if ($r->ir['kind'] === 'count') {
            $count = $answer['count'] ?? null;
            if (!is_int($count)) {
                throw self::answerError('a count answer has no count');
            }
            return $count;
        }
        if (!array_key_exists('value', $answer)) {
            throw self::answerError("a {$r->ir['kind']} answer has no value");
        }
        return self::aggregateValue($answer['value']);
    }

    /**
     * The write answer {affected, keys}. keys holds the primary keys of inserted rows in insert order:
     * an identity is an integer, and a key_prefix key is text.
     *
     * @return array{0: list<int|float|string|null>, 1: int}
     */
    public static function write(Db $db, Request $r): array
    {
        [$answer] = self::call($db, $r);
        $affected = $answer['affected'] ?? null;
        if (!is_int($affected)) {
            throw self::answerError("a {$r->ir['kind']} answer has no affected");
        }
        $keys = $answer['keys'] ?? [];
        if (!is_array($keys) || !array_is_list($keys)) {
            throw self::answerError("a {$r->ir['kind']} answer has keys that are no list");
        }
        return [array_map(self::aggregateValue(...), $keys), $affected];
    }

    /**
     * The value of a sum or avg answer, and the key of a write answer: an integer, a decimal, a decimal
     * string, or null if none.
     */
    private static function aggregateValue(mixed $v): int|float|string|null
    {
        if ($v === null || is_int($v) || is_float($v) || is_string($v)) {
            return $v;
        }
        throw self::answerError('the value ' . json_encode($v) . ' is no number');
    }

    /** The join and relation that a row of a markdown answer holds in its last cell. */
    public static function links(array $row): MarkdownLinks
    {
        $links = $row[count($row) - 1] ?? null;
        return $links instanceof MarkdownLinks ? $links : new MarkdownLinks();
    }

    /** Whether the row was read as a JSON object. */
    private static function isObject(mixed $v): bool
    {
        return is_array($v) && ($v === [] || !array_is_list($v));
    }

    /**
     * The placement of the node for query $q. The columns are decided by the node's first row in the answer,
     * and later rows must have the same output in the same
     * order. The placement of join and relation is decided by the first row of the child rows. A node with no rows
     * has no columns: the node's model is not built. A group count with no rows has the group column and
     * row_count as its columns.
     *
     * @param list<mixed> $rows
     */
    private static function layout(RuntimeModel $m, array $q, bool $groups, array $rows): array
    {
        $ent = $m->entities[$q['entity']];
        $joins = array_column($q['joins'] ?? [], null, 'rel');
        $rels = array_column($q['relations'] ?? [], null, 'rel');
        $asm = ['entity' => $q['entity'], 'columns' => [], 'key' => []];
        $first = $rows[0] ?? null;
        // A group count with no rows still has the result's columns: the group column and row_count.
        $outputs = $first === null && $groups ? [...$q['group_by'], 'row_count'] : null;
        if ($first !== null) {
            if (!self::isObject($first)) {
                throw self::answerError("a row of {$q['entity']} is not a JSON object");
            }
            $outputs = [];
            foreach (array_keys($first) as $name) {
                $name = (string) $name;
                if (!isset($joins[$name]) && !isset($rels[$name])) {
                    $outputs[] = $name;
                }
            }
        }
        if ($outputs !== null) {
            foreach ($outputs as $i => $name) {
                $asm['columns'][] = self::outCol($m, $q, $ent, $groups, $name, $i);
            }
            foreach ($groups ? $q['group_by'] : $ent['pk'] as $key) {
                $i = array_search($key, $outputs, true);
                if ($i === false) {
                    throw self::answerError("{$q['entity']} answers no $key, a key of its rows");
                }
                $asm['key'][] = ['column' => $key, 'index' => $i];
            }
        }
        foreach ($joins as $name => $j) {
            $child = [];
            foreach ($rows as $row) {
                if (self::isObject($row) && ($row[$name] ?? null) !== null) {
                    $child[] = $row[$name];
                    break;
                }
            }
            $asm['children'][] = ['rel' => $name, 'kind' => 'join',
                'assemble' => self::layout($m, $j['query'], false, $child)];
        }
        foreach ($rels as $name => $rel) {
            $child = [];
            foreach ($rows as $row) {
                $items = self::isObject($row) ? self::relationItems($row[$name] ?? null, $rel['query'], $name) : [];
                if ($items !== []) {
                    $child = [$items[0]];
                    break;
                }
            }
            $target = $m->entities[$rel['query']['entity']];
            $parentKeys = array_column($rel['keys'], 'left');
            $childKeys = array_column($rel['keys'], 'right');
            $asm['children'][] = [
                'rel' => $name, 'kind' => $rel['kind'], 'flatten' => !empty($rel['query']['flatten']),
                'assemble' => self::layout($m, $rel['query'], false, $child),
                // If this row is the row that a relation row's foreign key points at, those rows belong to this
                // row (same as the planner).
                'cascade' => empty($rel['query']['no_cascade_delete']) && $parentKeys === $ent['pk']
                    && $childKeys !== $target['pk'],
            ];
        }
        return $asm;
    }

    /**
     * The placement of output names: the group count's row_count, a scalar subquery, a column function, or
     * otherwise the node entity's column. The markdown executor leaves every codec stage to the client, so
     * the whole codec of the column
     * is the style it decodes.
     */
    private static function outCol(RuntimeModel $m, array $q, array $ent, bool $groups, string $name, int $index): array
    {
        if ($groups && $name === 'row_count') {
            return ['index' => $index, 'name' => $name, 'type' => 'i64'];
        }
        if (!$groups && isset($q['columns']['sub'][$name])) {
            $sub = $q['columns']['sub'][$name];
            $type = match ($sub['agg'] ?? '') {
                'count' => 'i64',
                'avg' => 'f64',
                default => RuntimeModel::column(
                    $m->entities[$sub['query']['entity']],
                    $sub['column']
                )['type'] ?? 'text',
            };
            return ['index' => $index, 'name' => $name, 'type' => $type];
        }
        if (!$groups && isset($q['columns']['fn'][$name])) {
            $cf = $q['columns']['fn'][$name];
            return ['index' => $index, 'name' => $name, 'column' => $cf['column'],
                'type' => Validator::functionType($cf['fn']['name'], RuntimeModel::column($ent, $cf['column']))];
        }
        $col = RuntimeModel::column($ent, $name) ?? throw self::answerError(
            "{$q['entity']} answers $name, which is no output of the request"
        );
        $out = ['index' => $index, 'name' => $name, 'column' => $name, 'type' => $col['type']];
        if ($col['codec'] !== []) {
            $out['styles'] = $col['codec'];
        }
        return $out;
    }

    /**
     * Reads a relation's value as a list of rows: a one relation is an object or null, a many relation is an array,
     * and a key_by relation is an object grouped by key.
     *
     * @return list<mixed>
     */
    private static function relationItems(mixed $value, array $q, string $rel): array
    {
        if ($value === null) {
            return [];
        }
        if (!is_array($value)) {
            throw self::answerError("relation $rel answers " . json_encode($value) . ', not rows');
        }
        if (($q['key_by'] ?? '') !== '' || array_is_list($value)) {
            return array_values($value);
        }
        return [$value];
    }

    /**
     * Reads the answer's rows as the positional rows of node placement $asm: the output values, and in the
     * last cell the join and relation rows. A codec column is decoded per node.
     *
     * @param list<mixed> $rows
     * @return list<list<mixed>>
     */
    private static function rows(Config $config, RuntimeModel $m, array $q, array $asm, array $rows): array
    {
        $joins = array_column($q['joins'] ?? [], null, 'rel');
        $rels = array_column($q['relations'] ?? [], null, 'rel');
        $children = array_column($asm['children'] ?? [], 'assemble', 'rel');
        $out = [];
        foreach ($rows as $row) {
            if (!self::isObject($row)) {
                throw self::answerError("a row of {$q['entity']} is not a JSON object");
            }
            $vals = [];
            $links = new MarkdownLinks();
            foreach ($row as $name => $value) {
                $name = (string) $name;
                if (isset($joins[$name])) {
                    $links->joins[$name] = $value === null ? null
                        : self::rows($config, $m, $joins[$name]['query'], $children[$name], [$value])[0];
                    continue;
                }
                if (isset($rels[$name])) {
                    $links->rels[$name] = self::rows(
                        $config,
                        $m,
                        $rels[$name]['query'],
                        $children[$name],
                        self::relationItems($value, $rels[$name]['query'], $name)
                    );
                    continue;
                }
                $col = $asm['columns'][count($vals)] ?? null;
                if ($col === null || $col['name'] !== $name) {
                    throw self::answerError("a row of {$q['entity']} answers $name where its first row answers "
                        . ($col['name'] ?? 'no more outputs'));
                }
                $vals[] = self::answerValue($col['type'], $value, "{$q['entity']}.$name");
            }
            if (count($vals) !== count($asm['columns'])) {
                throw self::answerError("a row of {$q['entity']} answers " . count($vals)
                    . ' outputs, its first row ' . count($asm['columns']));
            }
            $vals[] = $links;
            $out[] = $vals;
        }
        $cells = $asm['columns'] === [] ? [] : Assemble::cells($asm, $m);
        if ($cells !== []) {
            Codec::decodeRows($out, $cells, $config);
        }
        return $out;
    }

    /**
     * Reads one answer value as a PHP value of the column type. The value is the same runtime value model as
     * a parameter.
     */
    private static function answerValue(string $type, mixed $v, string $where): mixed
    {
        if ($v === null) {
            return null;
        }
        $ok = match ($type) {
            'i16', 'i32', 'i64' => is_int($v),
            'f64' => is_int($v) || is_float($v),
            'bool' => is_bool($v),
            default => is_string($v),
        };
        if ($ok && $type === 'bytes') {
            $v = base64_decode($v, true);
            $ok = $v !== false;
        }
        if (!$ok) {
            throw new OrmException(Code::CODEC_DECODE, "$where: the answer value " . json_encode($v)
                . " is not a $type value");
        }
        return $type === 'f64' ? (float) $v : $v;
    }
}
