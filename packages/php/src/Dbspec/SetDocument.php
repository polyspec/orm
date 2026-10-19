<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The result of one text of a set (Dbspec::parseSet, docs/spec/dbspec.md "Parsing a set"): the name that the parser reads
 * from its header, '' when the header fails; whether the text is external; and what one parse of the text returns,
 * its document and positions or its diagnostics. A text whose name an earlier text has is not parsed: it has no
 * document and no positions, and the one diagnostic `name.duplicate`.
 */
final readonly class SetDocument
{
    /**
     * @param ?list<Position> $positions
     * @param list<Diagnostic> $diagnostics
     */
    public function __construct(
        public string $name,
        public bool $external,
        public ?Document $document,
        public ?array $positions,
        public array $diagnostics,
    ) {
    }
}
