<?php
declare(strict_types=1);

namespace Orm\Dbspec;

/**
 * A column that a rollback statement makes non-null again (docs/plans.md
 * "Steps", restoring non-null columns): its table, its name in the applied
 * plan and the SQL text of its source default, or null without one.
 */
final readonly class NullCheck
{
    public function __construct(public string $table, public string $column, public ?string $default)
    {
    }
}
