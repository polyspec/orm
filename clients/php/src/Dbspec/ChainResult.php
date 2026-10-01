<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** The outcome of Dbspec::chain: the plans in chain order and no diagnostics, or the diagnostics and no plans. */
final readonly class ChainResult
{
    /**
     * @param ?list<Plan> $plans
     * @param list<Diagnostic> $diagnostics
     */
    private function __construct(public ?array $plans, public array $diagnostics)
    {
    }

    /** @param list<Plan> $plans */
    public static function valid(array $plans): self
    {
        return new self($plans, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid chain result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
