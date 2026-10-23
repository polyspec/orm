<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * An ordered set of models keyed by primary key, key column, or key callback.
 * A later row with the same key replaces the earlier one. The integer 7 and
 * the text "7" are different keys.
 *
 * @template TModel
 * @implements \IteratorAggregate<int|string|bool|Bytes|\DateTimeInterface, TModel>
 */
final class Collection implements \IteratorAggregate, \Countable, \JsonSerializable
{
    /** @var array<string, array{0: int|string|bool|Bytes|\DateTimeInterface, 1: TModel}> */
    private array $items = [];
    /** @var array<string, mixed> */
    private array $fetched = [];

    /**
     * The collection key of a value: an integer, a string, a boolean, Bytes or a date and time. SQL NULL is an error.
     *
     * @return int|string|bool|Bytes|\DateTimeInterface
     */
    public static function keyOf(mixed $key): int|string|bool|Bytes|\DateTimeInterface
    {
        return match (true) {
            is_int($key), is_string($key), is_bool($key), $key instanceof Bytes,
            $key instanceof \DateTimeInterface => $key,
            $key === null => throw new OrmException(Code::CODEC_DECODE, 'collection row identity contains SQL NULL'),
            default => (string) $key,
        };
    }

    /**
     * The identity of a collection key: equal keys have equal identities and keys of different types never share one.
     *
     * @param int|string|bool|Bytes|\DateTimeInterface $key
     */
    public static function identityOf(mixed $key): string
    {
        $key = self::keyOf($key);
        return match (true) {
            is_int($key) => 'i' . $key,
            is_string($key) => 's' . $key,
            is_bool($key) => $key ? 'b1' : 'b0',
            $key instanceof Bytes => 'x' . bin2hex($key->bytes),
            default => 'd' . \DateTimeImmutable::createFromInterface($key)
                ->setTimezone(new \DateTimeZone('UTC'))
                ->format('Y-m-d H:i:s.u'),
        };
    }

    /**
     * @internal
     * @param TModel $model
     */
    public function put(int|string|bool|Bytes|\DateTimeInterface $key, Model $model): void
    {
        $key = self::keyOf($key);
        $this->items[self::identityOf($key)] = [$key, $model];
    }

    /** @return (TModel&Model)|null */
    public function get(int|string|bool|Bytes|\DateTimeInterface $key): ?Model
    {
        return $this->items[self::identityOf($key)][1] ?? null;
    }

    public function has(int|string|bool|Bytes|\DateTimeInterface $key): bool
    {
        return isset($this->items[self::identityOf($key)]);
    }

    /** @return (TModel&Model)|null */
    public function first(): ?Model
    {
        foreach ($this->items as [, $m]) {
            return $m;
        }
        return null;
    }

    /** @return list<int|string|bool|Bytes|\DateTimeInterface> */
    public function keys(): array
    {
        return array_values(array_map(
            static fn(array $e): int|string|bool|Bytes|\DateTimeInterface => $e[0],
            $this->items
        ));
    }

    /** @return list<TModel> */
    public function all(): array
    {
        return array_values(array_map(static fn(array $e): Model => $e[1], $this->items));
    }

    /** @return list<array{0: int|string|bool|Bytes|\DateTimeInterface, 1: TModel}> */
    public function entries(): array
    {
        return array_values($this->items);
    }

    public function count(): int
    {
        return count($this->items);
    }

    /** @return \Traversable<int|string|bool|Bytes|\DateTimeInterface, TModel> */
    public function getIterator(): \Traversable
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
    public function fetchedValue(int|string|bool|Bytes|\DateTimeInterface $key): mixed
    {
        return $this->fetched[self::identityOf($key)] ?? null;
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

    /**
     * Sets the connection of every row.
     *
     * @return Collection<TModel>
     */
    public function connect(Db $db): Collection
    {
        foreach ($this->items as [, $m]) {
            $m->connect($db);
        }
        return $this;
    }

    /**
     * Short form of connect.
     *
     * @return Collection<TModel>
     */
    public function __invoke(Db $db): Collection
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
