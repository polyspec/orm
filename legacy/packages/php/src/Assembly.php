<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** @internal assembles the rows of one executed plan */
final class Assembly
{
    /** @var array<int, list<Model>> models made for each builder model */
    public array $made = [];

    public readonly \DateTimeZone $zone;

    public function __construct(
        public readonly Db $db,
        public readonly ?Db $conn,
        private readonly array $result,
        public readonly bool $track = false
    ) {
        $this->zone = $db->zone();
    }

    /**
     * The row of join $ch. If absent, null. The join columns are in the parent row, and if the first of them is NULL,
     * the join row is absent.
     *
     * @param list<mixed> $parent
     * @return list<mixed>|null
     */
    public function joinRow(array $ch, array $parent): ?array
    {
        $first = $ch['assemble']['columns'][0]['index'] ?? null;
        return $first !== null && $parent[$first] !== null ? $parent : null;
    }

    /**
     * Row placement of relation $ch: the placement of the relation step.
     */
    public function relationAssemble(array $ch): array
    {
        return $this->result['steps'][$ch['step']]['step']['assemble'];
    }

    /**
     * The rows of parent row $parent in relation $ch, found by the key of the relation step's rows.
     *
     * @return list<list<mixed>>
     */
    public function related(array $ch, array $parent): array
    {
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
