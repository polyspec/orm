<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** `rename table <old> <new>` of a plan. */
final readonly class TableRename
{
    public function __construct(public string $old, public string $new)
    {
    }
}
