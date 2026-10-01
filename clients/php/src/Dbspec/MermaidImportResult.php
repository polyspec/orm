<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * The outcome of Dbspec::importMermaid: a document and what import leaves
 * out, ordered by table, kind and name, and no diagnostics; or the `mermaid`
 * diagnostic and no document (docs/mermaid.md "Import").
 */
final readonly class MermaidImportResult
{
    /**
     * @param list<Unsupported> $dropped
     * @param list<Diagnostic> $diagnostics
     */
    private function __construct(public ?Document $document, public array $dropped, public array $diagnostics)
    {
    }

    /** @param list<Unsupported> $dropped */
    public static function valid(Document $document, array $dropped): self
    {
        return new self($document, $dropped, []);
    }

    /** @param non-empty-list<Diagnostic> $diagnostics */
    public static function invalid(array $diagnostics): self
    {
        if ($diagnostics === []) {
            throw new \LogicException('An invalid Mermaid import result needs a diagnostic');
        }
        return new self(null, [], $diagnostics);
    }
}
