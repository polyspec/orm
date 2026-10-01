<?php
declare(strict_types=1);

namespace Orm\Dbspec;

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

    public function __construct(public string $name)
    {
    }
}
