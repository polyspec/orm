<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/** Grouped values in result order, without partial model rows. */
final readonly class GroupRows implements \Countable, \IteratorAggregate, \JsonSerializable
{
    /** @param list<GroupRow> $rows */
    public function __construct(private array $rows)
    {
        foreach ($rows as $row) {
            if (!$row instanceof GroupRow) {
                throw new OrmException(Code::CONFIG, 'group result contains an invalid row');
            }
        }
    }

    public function count(): int
    {
        return count($this->rows);
    }

    /** @return list<GroupRow> */
    public function all(): array
    {
        return $this->rows;
    }

    /** @return \Traversable<int, GroupRow> */
    public function getIterator(): \Traversable
    {
        yield from $this->rows;
    }

    /** @return list<array<string, mixed>> */
    public function toArray(): array
    {
        return array_map(static fn(GroupRow $row): array => $row->toArray(), $this->rows);
    }

    public function jsonSerialize(): array
    {
        return $this->toArray();
    }
}
