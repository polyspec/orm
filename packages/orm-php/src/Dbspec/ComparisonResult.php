<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** Dbspec::compareSchemas 의 결과: diagnostic 없는 차이, 또는 차이 없는 diagnostic 이다. */
final readonly class ComparisonResult
{
    /**
     * @param ?list<Difference> $differences
     * @param list<Diagnostic> $diagnostics
     */
    private function __construct(public ?array $differences, public array $diagnostics)
    {
    }

    /** @param list<Difference> $differences */
    public static function valid(array $differences): self
    {
        return new self($differences, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid comparison result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
