<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** `rename column <table>.<old> <new>` of a plan; the table is its name in the target. */
final readonly class ColumnRename
{
    public function __construct(public string $table, public string $old, public string $new)
    {
    }
}
