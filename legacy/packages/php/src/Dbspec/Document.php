<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** A parsed dbspec document. Comments are kept with the line that follows them. */
final class Document
{
    /** @var list<UseLine> */
    public array $uses = [];
    /** @var list<Table> */
    public array $tables = [];
    /** @var list<Diagram> */
    public array $diagrams = [];
    /** @var list<string> Comment lines after the last line of the document. */
    public array $trailingComments = [];
    /**
     * Means the document is not owned by the set but is an external document that an owned document uses. External
     * documents are parsed and checked, but not rendered, installed, compared, or generated (docs/spec/dbspec.md
     * "Documents and use"). They do not appear in the document text.
     */
    public bool $external = false;

    public function __construct(public string $name)
    {
    }
}
