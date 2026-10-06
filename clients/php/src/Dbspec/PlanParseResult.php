<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** The outcome of Dbspec::parsePlan: a plan and no diagnostics, or the diagnostics and no plan. */
final readonly class PlanParseResult
{
    /** @param list<Diagnostic> $diagnostics */
    private function __construct(public ?Plan $plan, public array $diagnostics)
    {
    }

    public static function valid(Plan $plan): self
    {
        return new self($plan, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid plan parse result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
