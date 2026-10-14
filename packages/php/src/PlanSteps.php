<?php
declare(strict_types=1);

namespace Polyspec\Orm;

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
