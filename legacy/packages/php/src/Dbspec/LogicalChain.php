<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The or and and chains of a dbspec check expression, which CheckDecoder and Expression both read: and binds tighter
 * than or, and each chain reads left to right.
 *
 * @internal
 */
trait LogicalChain
{
    /** Consumes the keyword $text when it comes next. */
    abstract private function word(string $text): bool;

    /** Reads one predicate, the operand of an and. */
    abstract private function predicate(): array;

    /** The node of $left $op $right. */
    abstract private function logicalNode(string $op, array $left, array $right): array;

    /** Reads a chain of $op, 'or' or 'and'. */
    private function logical(string $op): array
    {
        $next = $op === 'or' ? fn(): array => $this->logical('and') : $this->predicate(...);
        $left = $next();
        while ($this->word($op)) {
            $left = $this->logicalNode($op, $left, $next());
        }
        return $left;
    }
}
