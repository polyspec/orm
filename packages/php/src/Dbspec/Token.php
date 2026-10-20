<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * A token of a dbspec text (docs/spec/dbspec.md "Syntax analysis"): its 1-based line, the number of code points
 * before it on its line, the number of code points before the code point after it, and its class.
 */
final readonly class Token
{
    public function __construct(
        public int $line,
        public int $start,
        public int $end,
        public string $class,
    ) {
    }
}
