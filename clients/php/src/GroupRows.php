<?php
declare(strict_types=1);

namespace Orm;

/** One grouped result with only selected values and a checked row count. */
final readonly class GroupRow implements \JsonSerializable
{
    /** @var array<string, mixed> */
    private array $values;
    private int $count;

    /** @param list<array{0: string, 1: mixed}> $entries */
    public function __construct(array $entries)
    {
        $values = [];
        foreach ($entries as $entry) {
            if (count($entry) !== 2) throw new OrmException(Code::CONFIG, 'group result entry must have a name and value');
            [$name, $value] = $entry;
            if ($name === '' || array_key_exists($name, $values)) {
                throw new OrmException(Code::CONFIG, "group result repeats or omits column $name");
            }
            $values[$name] = $value;
        }
        if (!array_key_exists('row_count', $values)) {
            throw new OrmException(Code::INTERNAL, 'group result has no row_count');
        }
        $count = self::checkedCount($values['row_count']);
        $values['row_count'] = $count;
        $this->values = $values;
        $this->count = $count;
    }

    private static function checkedCount(mixed $value): int
    {
        if (is_int($value)) {
            if ($value < 0) throw new OrmException(Code::INTERNAL, 'group result has a negative row_count');
            return $value;
        }
        if (!is_string($value) || preg_match('/^(0|[1-9][0-9]*)$/D', $value) !== 1 ||
            strlen($value) > strlen((string) PHP_INT_MAX) ||
            (strlen($value) === strlen((string) PHP_INT_MAX) && strcmp($value, (string) PHP_INT_MAX) > 0)) {
            throw new OrmException(Code::CODEC_DECODE, 'group result row_count is not an exact integer');
        }
        return (int) $value;
    }

    public function count(): int { return $this->count; }

    public function value(string $name): mixed
    {
        if (!array_key_exists($name, $this->values)) {
            throw new OrmException(Code::COLUMN_UNSELECTED, "group column $name was not selected");
        }
        return $this->values[$name];
    }

    /** @return array<string, mixed> */
    public function toArray(): array { return $this->values; }

    public function jsonSerialize(): array { return $this->toArray(); }
}

/** Grouped values in result order, without partial model rows. */
final readonly class GroupRows implements \Countable, \IteratorAggregate, \JsonSerializable
{
    /** @param list<GroupRow> $rows */
    public function __construct(private array $rows)
    {
        foreach ($rows as $row) {
            if (!$row instanceof GroupRow) throw new OrmException(Code::CONFIG, 'group result contains an invalid row');
        }
    }

    public function count(): int { return count($this->rows); }

    /** @return list<GroupRow> */
    public function all(): array { return $this->rows; }

    public function getIterator(): \Traversable { yield from $this->rows; }

    /** @return list<array<string, mixed>> */
    public function toArray(): array { return array_map(static fn(GroupRow $row): array => $row->toArray(), $this->rows); }

    public function jsonSerialize(): array { return $this->toArray(); }
}
