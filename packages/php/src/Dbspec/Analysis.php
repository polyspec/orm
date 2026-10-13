<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The result of Dbspec::analyze: the parse result unchanged, and the tokens of the text in source order
 * (docs/dbspec.md "Syntax analysis"). The document and the positions are null when the parse has a diagnostic.
 */
final readonly class Analysis
{
    /**
     * @param ?list<Position> $positions
     * @param list<Diagnostic> $diagnostics
     * @param list<Token> $tokens
     */
    public function __construct(
        public ?Document $document,
        public ?array $positions,
        public array $diagnostics,
        public array $tokens,
    ) {
    }
}
