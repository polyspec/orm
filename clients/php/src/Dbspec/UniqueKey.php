<?php
declare(strict_types=1);

namespace Orm\Dbspec;

final class UniqueKey
{
    /**
     * @param list<string> $columns
     * @param list<string> $comments
     */
    public function __construct(public string $name, public array $columns, public array $comments = [])
    {
    }
}
