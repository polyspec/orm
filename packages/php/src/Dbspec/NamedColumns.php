<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * @template TColumn
 * @internal
 */
trait NamedColumns
{
    /**
     * @param list<TColumn> $columns
     * @param list<string> $comments
     */
    public function __construct(public string $name, public array $columns, public array $comments = [])
    {
    }
}
