<?php

declare(strict_types=1);

namespace Polyspec\Orm\Internal;

/**
 * Forward-only iterator over a PostgreSQL statement cursor.
 *
 * @internal
 */
final class PgsqlStatementIterator implements \Iterator
{
    private int $key = 0;
    private mixed $current = false;

    public function __construct(private readonly PgsqlStatementAdapter $statement)
    {
    }

    public function current(): mixed
    {
        return $this->current;
    }

    public function key(): int
    {
        return $this->key;
    }

    public function next(): void
    {
        $this->key++;
        $this->current = $this->statement->fetch();
    }

    public function rewind(): void
    {
        $this->key = 0;
        $this->current = $this->statement->fetch();
    }

    public function valid(): bool
    {
        return $this->current !== false;
    }
}
