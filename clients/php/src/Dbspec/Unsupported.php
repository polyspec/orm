<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * An object that introspection cannot read into dbspec (docs/dialects.md
 * "Introspection"). The kind is column, index, unique, foreign_key, check,
 * trigger, view, routine, sequence, event, partition or table; the table is
 * empty for an object without one.
 */
final readonly class Unsupported
{
    public function __construct(
        public string $kind,
        public string $table,
        public string $name,
        public string $reason,
    ) {
    }
}
