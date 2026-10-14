<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal assembles the rows of one executed plan */
final class Assembly
{
    /** @var array<int, list<Model>> models made for each builder model */
    public array $made = [];

    public readonly \DateTimeZone $zone;
    /** markdown 답의 result인지다: 각 행의 마지막 칸이 그 행의 join과 relation 행(MarkdownLinks)이다. */
    private readonly bool $markdown;

    public function __construct(public readonly Db $db, public readonly ?Db $conn, private readonly array $result, public readonly bool $track = false)
    {
        $this->zone = $db->zone();
        $this->markdown = !empty($result['markdown']);
    }

    /**
     * join $ch의 행이다. 없으면 null이다. SQL 결과에서는 join column이 부모 행에 함께 있고 첫 column이
     * NULL이면 없다. markdown 답에서는 부모 행의 마지막 칸이 join 행을 가진다.
     *
     * @param list<mixed> $parent
     * @return list<mixed>|null
     */
    public function joinRow(array $ch, array $parent): ?array
    {
        if ($this->markdown) {
            return Markdown::links($parent)->joins[$ch['rel']] ?? null;
        }
        $first = $ch['assemble']['columns'][0]['index'] ?? null;
        return $first !== null && $parent[$first] !== null ? $parent : null;
    }

    /** relation $ch의 행 배치다: SQL 결과에서는 relation step의 배치, markdown 답에서는 child 자신의 배치다. */
    public function relationAssemble(array $ch): array
    {
        return $this->markdown ? $ch['assemble'] : $this->result['steps'][$ch['step']]['step']['assemble'];
    }

    /**
     * relation $ch에서 부모 행 $parent의 행이다. SQL 결과에서는 relation step의 행을 key로 찾고,
     * markdown 답에서는 부모 행의 마지막 칸이 relation 행을 가진다.
     *
     * @return list<list<mixed>>
     */
    public function related(array $ch, array $parent): array
    {
        if ($this->markdown) {
            return Markdown::links($parent)->rels[$ch['rel']] ?? [];
        }
        $sr = $this->result['steps'][$ch['step']] ?? null;
        if ($sr === null) {
            return [];
        }
        $ifp = $sr['step']['parent']['if_parent'] ?? null;
        if ($ifp !== null && !Db::sameScalar($parent[$ifp['index']], $this->result['params'][$ifp['param']])) {
            return [];
        }
        $key = Db::rowKey($parent, $ch['parent_keys']);
        if ($key === null) {
            return [];
        }
        $out = [];
        foreach ($sr['byKey'][$key] ?? [] as $j) {
            $out[] = $sr['data'][$j];
        }
        return $out;
    }
}
