<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * One change of a plan's diff (docs/plans.md "Diff"). The table is its
 * target name; `drop_table` and the dropped objects name the source table.
 */
final readonly class Change
{
    public function __construct(public string $kind, public string $table, public string $name)
    {
    }
}
