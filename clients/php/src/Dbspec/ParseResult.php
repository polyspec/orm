<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * The outcome of Dbspec::parse: a document and no diagnostics, or every
 * diagnostic in source order and no document, never both.
 */
final readonly class ParseResult
{
    /** @param list<Diagnostic> $diagnostics */
    private function __construct(public ?Document $document, public array $diagnostics)
    {
    }

    public static function valid(Document $document): self
    {
        return new self($document, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid parse result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
