<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** The outcome of Dbspec::planSteps: the steps and no diagnostics, or the diagnostics and no steps. */
final readonly class PlanStepsResult
{
    /**
     * @param ?list<PlanStep> $steps
     * @param list<Diagnostic> $diagnostics
     */
    private function __construct(public ?array $steps, public array $diagnostics)
    {
    }

    /** @param list<PlanStep> $steps */
    public static function valid(array $steps): self
    {
        return new self($steps, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid plan steps result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
