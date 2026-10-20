<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Result of Dbspec::readFile: file text with no diagnostic, or a signature
 * diagnostic with no text; the two are never held together.
 */
final readonly class ReadResult
{
    /** @param list<Diagnostic> $diagnostics */
    private function __construct(public ?string $text, public array $diagnostics)
    {
    }

    public static function valid(string $text): self
    {
        return new self($text, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid read result needs a diagnostic');
        }
        return new self(null, $diagnostics);
    }
}
