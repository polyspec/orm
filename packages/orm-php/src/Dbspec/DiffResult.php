<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** The outcome of Dbspec::diff: the changes and no diagnostics, or the diagnostics and no changes. */
final readonly class DiffResult
{
    /**
     * @param ?list<Change> $changes
     * @param list<Diagnostic> $diagnostics
     */
    private function __construct(public ?array $changes, public array $diagnostics)
    {
    }

    /** @param list<Change> $changes */
    public static function valid(array $changes): self
    {
        return new self($changes, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid diff result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
