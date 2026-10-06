<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * One step of a plan (docs/plans.md "Steps"): its statement, its rollback
 * statement or, without one, the reason in `irreversible` (empty for a
 * finalize step), its effect, the restore statements that replace the
 * statement and the rollback statement when `restoreIf` holds, the null
 * checks of its rollback, and whether it is a finalize step.
 */
final readonly class PlanStep
{
    /** @param list<NullCheck> $nullChecks */
    public function __construct(
        public string $statement,
        public string $rollback,
        public string $irreversible,
        public Effect $effect,
        public string $restore = '',
        public string $rollbackRestore = '',
        public ?Effect $restoreIf = null,
        public array $nullChecks = [],
        public bool $finalize = false,
    ) {
    }
}
