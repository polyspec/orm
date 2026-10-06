<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/** One SCHEMA_INVALID finding: the rule, the 1-based line and column of the offending token, and a message. */
final readonly class Diagnostic
{
    public function __construct(
        public string $rule,
        public int $line,
        public int $column,
        public string $message,
    ) {
    }
}
