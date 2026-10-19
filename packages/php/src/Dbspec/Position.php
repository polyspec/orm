<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * One declaration of a parsed document: its kind, its path of enclosing names
 * and its own name, and the 1-based line and column, in Unicode code points,
 * of its name token or, for a setting and the primary key, of its keyword
 * (docs/spec/dbspec.md "Declaration positions").
 */
final readonly class Position
{
    /** @param list<string> $path */
    public function __construct(
        public string $kind,
        public array $path,
        public int $line,
        public int $column,
    ) {
    }
}
