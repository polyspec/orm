<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The outcome of Dbspec::parse: a document, its declaration positions in source
 * order, and no diagnostics; or every diagnostic in source order and no document
 * and no positions, never both.
 */
final readonly class ParseResult
{
    /**
     * @param list<Diagnostic> $diagnostics
     * @param ?list<Position> $positions
     */
    private function __construct(public ?Document $document, public array $diagnostics, public ?array $positions)
    {
    }

    /** @param non-empty-list<Position> $positions */
    public static function valid(Document $document, array $positions): self
    {
        return new self($document, [], $positions);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid parse result needs a diagnostic');
        }
        return new self(null, $diagnostics, null);
    }
}
