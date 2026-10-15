<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal The markdown IR executor client (docs/protocol.md §5): a markdown connection sends
 * each validated request as one message to a flowmark server and assembles the rows it answers.
 * It plans nothing and sends no SQL.
 */
final class Markdown
{
    /** markdown 연결에서 SQL 전용 surface가 받는 오류다(docs/dialects.md "Markdown IR executor"). */
    public static function unsupported(string $surface): OrmException
    {
        return new OrmException(Code::CAPABILITY_UNSUPPORTED, "$surface is not supported by the markdown IR executor");
    }

    private static function answerError(string $message): OrmException
    {
        return new OrmException(Code::INTERNAL, 'the flowmark answer: ' . $message);
    }

    /**
     * r을 검증하고 그 request message를 연결의 session에서 실행해 답과 runtime model을 돌려준다.
     * message는 {ir_version, manifest_hash, request, params, now}다.
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
     * parameter $i의 runtime value model JSON 값이다: decimal은 string, bytes는 base64, datetime은
     * UTC의 YYYY-MM-DD HH:MM:SS.ffffff, date는 YYYY-MM-DD, time은 HH:MM:SS.ffffff다(p 뒤 자리는 0, 문자열 값도 같다). 어느 form인지는
     * parameter가 채우는 slot의 type이 정한다. hex와 ip style column의 slot은 SQL 연결처럼 client가
     * 값을 encode해 보낸다.
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
     * row read(one, all, group_count, paginate)의 답을 plan과 위치 result로 읽는다. plan은 root
     * node의 배치 하나이고, result의 각 행의 마지막 칸이 그 행의 join과 relation 행(MarkdownLinks)이다.
     * paginate의 셋째 값은 조건에 맞는 모든 행의 수다.
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
        $plan = ['kind' => $kind, 'steps' => [['role' => 'main', 'assemble' => self::layout($model, $r->ir, $groups, $rows)]]];
        Assemble::index($plan, $model);
        $main = self::rows($db->config(), $model, $r->ir, $plan['steps'][0]['assemble'], $rows);
        return [$plan, ['main' => $main, 'steps' => [], 'params' => $r->params, 'markdown' => true], is_int($count) ? $count : 0];
    }

    /** count, sum, avg의 답이다. */
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
     * write의 답 {affected, keys}이다. keys는 insert한 행의 primary key를 insert 순서로 담는다:
     * identity는 정수, key_prefix key는 text다.
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

    /** sum과 avg 답의 값, 그리고 write 답의 key다: 정수, 소수, decimal string, 없으면 null이다. */
    private static function aggregateValue(mixed $v): int|float|string|null
    {
        if ($v === null || is_int($v) || is_float($v) || is_string($v)) {
            return $v;
        }
        throw self::answerError('the value ' . json_encode($v) . ' is no number');
    }

    /** markdown 답의 행이 마지막 칸에 가진 join과 relation이다. */
    public static function links(array $row): MarkdownLinks
    {
        $links = $row[count($row) - 1] ?? null;
        return $links instanceof MarkdownLinks ? $links : new MarkdownLinks();
    }

    /** JSON object로 읽은 행인지다. */
    private static function isObject(mixed $v): bool
    {
        return is_array($v) && ($v === [] || !array_is_list($v));
    }

    /**
     * query $q의 node 배치다. column은 답에서 그 node의 첫 행이 정하고, 그 뒤 행은 같은 output을 같은
     * 순서로 가져야 한다. join과 relation의 배치는 그 child 행의 첫 행이 정한다. 행이 없는 node는
     * column이 없다: 그 node의 model은 만들어지지 않는다. 행이 없는 group count는 group column과
     * row_count를 column으로 가진다.
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
        // 행이 없는 group count도 그 결과의 column을 가진다: group column과 row_count다.
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
            $asm['children'][] = ['rel' => $name, 'kind' => 'join', 'assemble' => self::layout($m, $j['query'], false, $child)];
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
                // 이 행이 relation 행의 외래 key가 가리키는 행이면 그 행들은 이 행에 속한다(planner와 같다).
                'cascade' => empty($rel['query']['no_cascade_delete']) && $parentKeys === $ent['pk'] && $childKeys !== $target['pk'],
            ];
        }
        return $asm;
    }

    /**
     * output 이름의 배치다: group count의 row_count, scalar subquery, column 함수, 아니면 node entity의
     * column이다. markdown executor는 모든 codec stage를 client에 맡기므로 column의 codec 전체가
     * decode할 style이다.
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
                default => RuntimeModel::column($m->entities[$sub['query']['entity']], $sub['column'])['type'] ?? 'text',
            };
            return ['index' => $index, 'name' => $name, 'type' => $type];
        }
        if (!$groups && isset($q['columns']['fn'][$name])) {
            $cf = $q['columns']['fn'][$name];
            return ['index' => $index, 'name' => $name, 'column' => $cf['column'], 'type' => Validator::functionType($cf['fn']['name'], RuntimeModel::column($ent, $cf['column']))];
        }
        $col = RuntimeModel::column($ent, $name) ?? throw self::answerError("{$q['entity']} answers $name, which is no output of the request");
        $out = ['index' => $index, 'name' => $name, 'column' => $name, 'type' => $col['type']];
        if ($col['codec'] !== []) {
            $out['styles'] = $col['codec'];
        }
        return $out;
    }

    /**
     * relation의 값을 행 목록으로 읽는다: one relation은 object나 null, many relation은 array,
     * key_by relation은 key로 묶은 object다.
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
     * 답의 행들을 node 배치 $asm의 위치 행으로 읽는다: output 값, 그리고 마지막 칸에 join과
     * relation의 행이다. codec column은 node마다 decode한다.
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
                    $links->joins[$name] = $value === null ? null : self::rows($config, $m, $joins[$name]['query'], $children[$name], [$value])[0];
                    continue;
                }
                if (isset($rels[$name])) {
                    $links->rels[$name] = self::rows($config, $m, $rels[$name]['query'], $children[$name], self::relationItems($value, $rels[$name]['query'], $name));
                    continue;
                }
                $col = $asm['columns'][count($vals)] ?? null;
                if ($col === null || $col['name'] !== $name) {
                    throw self::answerError("a row of {$q['entity']} answers $name where its first row answers " . ($col['name'] ?? 'no more outputs'));
                }
                $vals[] = self::answerValue($col['type'], $value, "{$q['entity']}.$name");
            }
            if (count($vals) !== count($asm['columns'])) {
                throw self::answerError("a row of {$q['entity']} answers " . count($vals) . ' outputs, its first row ' . count($asm['columns']));
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

    /** 답의 값 하나를 column type의 PHP 값으로 읽는다. 값은 parameter와 같은 runtime value model이다. */
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
            throw new OrmException(Code::CODEC_DECODE, "$where: the answer value " . json_encode($v) . " is not a $type value");
        }
        return $type === 'f64' ? (float) $v : $v;
    }
}
