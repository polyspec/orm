<?php
declare(strict_types=1);

namespace Orm;

/**
 * An ordered set of models keyed by primary key, key column, or key callback.
 * A later row with the same key replaces the earlier one. The integer 7 and
 * the text "7" are different keys.
 * @implements \IteratorAggregate<int|string, Model>
 */
final class Collection implements \IteratorAggregate, \Countable, \JsonSerializable
{
    /** @var array<string, array{0: int|string, 1: Model}> */
    private array $items = [];
    /** @var array<string, mixed> */
    private array $fetched = [];

    public static function keyOf(mixed $key): int|string
    {
        return match (true) {
            is_int($key), is_string($key) => $key,
            is_bool($key) => (int) $key,
            $key === null => '',
            $key instanceof \DateTimeInterface => $key->format('Y-m-d H:i:s.u'),
            default => (string) $key,
        };
    }

    private static function slot(int|string $key): string
    {
        return (is_int($key) ? 'i' : 's') . $key;
    }

    /** @internal */
    public function put(int|string $key, Model $model): void
    {
        $this->items[self::slot($key)] = [$key, $model];
    }

    public function get(int|string $key): ?Model
    {
        return $this->items[self::slot($key)][1] ?? null;
    }

    public function has(int|string $key): bool
    {
        return isset($this->items[self::slot($key)]);
    }

    public function first(): ?Model
    {
        foreach ($this->items as [, $m]) {
            return $m;
        }
        return null;
    }

    /** @return list<int|string> */
    public function keys(): array
    {
        return array_values(array_map(static fn(array $e): int|string => $e[0], $this->items));
    }

    /** @return list<Model> */
    public function all(): array
    {
        return array_values(array_map(static fn(array $e): Model => $e[1], $this->items));
    }

    /** @return list<array{0: int|string, 1: Model}> */
    public function entries(): array
    {
        return array_values($this->items);
    }

    public function count(): int
    {
        return count($this->items);
    }

    public function getIterator(): \Generator
    {
        foreach ($this->items as [$key, $m]) {
            yield $key => $m;
        }
    }

    /** @internal */
    public function fetchValues(\Closure $fn): void
    {
        foreach ($this->items as $slot => [, $m]) {
            $this->fetched[$slot] = $fn($m);
        }
    }

    /** The fetchValue() result of the key. */
    public function fetchedValue(int|string $key): mixed
    {
        return $this->fetched[self::slot($key)] ?? null;
    }

    /** @return list<mixed> the fetchValue() results in order */
    public function fetchedValues(): array
    {
        $out = [];
        foreach ($this->items as $slot => $_) {
            $out[] = $this->fetched[$slot] ?? null;
        }
        return $out;
    }

    /** Sets the connection of every row. */
    public function connect(Db $db): self
    {
        foreach ($this->items as [, $m]) {
            $m->connect($db);
        }
        return $this;
    }

    /** Short form of connect. */
    public function __invoke(Db $db): self
    {
        return $this->connect($db);
    }

    /** Deletes every row in one transaction; delete(true) first deletes loaded related rows. */
    public function delete(bool $recursive = false): void
    {
        $first = $this->first();
        if ($first === null) {
            return;
        }
        Db::inTransaction($first->connection(), function () use ($recursive): void {
            foreach ($this->items as [, $m]) {
                $m->deleteRow($recursive);
            }
        });
    }

    /** @return list<array<string, mixed>> */
    public function toArray(): array
    {
        return array_map(static fn(Model $m): array => $m->toArray(), $this->all());
    }

    /** The models as a JSON array of Model::toJson texts. */
    public function toJson(): string
    {
        return '[' . implode(',', array_map(static fn(Model $m): string => $m->toJson(), $this->all())) . ']';
    }

    public function jsonSerialize(): array
    {
        return $this->all();
    }
}

/** One page of rows. */
final readonly class Page
{
    public function __construct(
        public Collection $items,
        public int $totalCount,
        public int $totalPages,
        public int $page,
        public int $perPage,
    ) {}
}
