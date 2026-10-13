<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

final class Index
{
    /**
     * @param list<IndexColumn> $columns
     * @param list<string> $comments
     */
    public function __construct(public string $name, public array $columns, public array $comments = [])
    {
    }
}
