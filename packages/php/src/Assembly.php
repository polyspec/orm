<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal assembles the rows of one executed plan */
final class Assembly
{
    /** @var array<int, list<Model>> models made for each builder model */
    public array $made = [];

    public readonly \DateTimeZone $zone;
    /** Whether this is the result of a markdown answer: the last cell of each row is that row's join and relation rows (MarkdownLinks). */
    private readonly bool $markdown;

    public function __construct(public readonly Db $db, public readonly ?Db $conn, private readonly array $result, public readonly bool $track = false)
    {
        $this->zone = $db->zone();
        $this->markdown = !empty($result['markdown']);
    }

    /**
     * The row of join $ch. If absent, null. In SQL results, the join column is in the parent row, and the first column
     * If NULL, absent. In a markdown answer, the last cell of the parent row holds the join row.
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

    /** Row placement of relation $ch: in SQL results, the placement of the relation step; in a markdown answer, the placement of the child itself. */
    public function relationAssemble(array $ch): array
    {
        return $this->markdown ? $ch['assemble'] : $this->result['steps'][$ch['step']]['step']['assemble'];
    }

    /**
     * The row of parent row $parent in relation $ch. In SQL results, it is found by the key of the relation step's row,
     * in a markdown answer, the last cell of the parent row holds the relation row.
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
        $key = Db::rowSlot($parent, $ch['parent_keys']);
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
