<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

final class PrimaryKey
{
    /**
     * @param list<string> $columns
     * @param list<string> $comments
     */
    public function __construct(public array $columns, public array $comments = [])
    {
    }
}
