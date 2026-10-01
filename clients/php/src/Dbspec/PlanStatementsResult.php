<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/** The outcome of Dbspec::planStatements: the statements and no diagnostics, or the diagnostics and no statements. */
final readonly class PlanStatementsResult
{
    /**
     * @param ?list<string> $statements
     * @param list<Diagnostic> $diagnostics
     */
    private function __construct(public ?array $statements, public array $diagnostics)
    {
    }

    /** @param list<string> $statements */
    public static function valid(array $statements): self
    {
        return new self($statements, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid plan statements result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
