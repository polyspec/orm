<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The result of Dbspec::format: the canonical text when the text has no diagnostic, else null with every diagnostic
 * (docs/spec/dbspec.md "Formatting").
 */
final readonly class FormatResult
{
    /** @param list<Diagnostic> $diagnostics */
    public function __construct(
        public ?string $text,
        public array $diagnostics,
    ) {
    }
}
