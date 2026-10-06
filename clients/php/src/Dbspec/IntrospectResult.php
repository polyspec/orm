<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The outcome of Dbspec::introspect: the document read from the database and
 * the objects it leaves out, ordered by table, kind and name with the objects
 * without a table first.
 */
final readonly class IntrospectResult
{
    /** @param list<Unsupported> $unsupported */
    public function __construct(public Document $document, public array $unsupported)
    {
    }
}
