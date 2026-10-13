<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The outcome of Dbspec::exportMermaid: the erDiagram text and what export
 * leaves out, ordered by table, kind and name (docs/mermaid.md "Export").
 */
final readonly class MermaidExportResult
{
    /** @param list<Unsupported> $dropped */
    public function __construct(public string $text, public array $dropped)
    {
    }
}
