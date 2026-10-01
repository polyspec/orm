<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * One occurrence of apply or recover (docs/plans.md "Apply"). The kind is
 * plan, statement, applied, verified or done; `step` is the statement index
 * of statement and applied, `steps` the plan's number of statements, and
 * `statement` the text of statement and applied.
 */
final readonly class ApplyEvent
{
    public function __construct(
        public string $kind,
        public string $plan,
        public int $step,
        public int $steps,
        public string $statement,
    ) {
    }
}
