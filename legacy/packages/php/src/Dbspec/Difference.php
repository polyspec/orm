<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * One difference between two schemas (docs/spec/plans.md "Comparison"). name is a column or
 * object name; for a table-level difference it is an empty string.
 */
final readonly class Difference
{
    public function __construct(public string $kind, public string $table, public string $name)
    {
    }
}
