<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use ArrayAccess;
use ArrayIterator;
use Countable;
use IteratorAggregate;
use PHPUnit\Framework\Assert;
use Traversable;

/**
 * A step of a recipe or its outcome as the helper reads it (FCV-4): a key that the helper never reads asserts nothing,
 * so a run records what it reads and an unread key fails the case by name.
 *
 * @implements ArrayAccess<string, mixed>
 * @implements IteratorAggregate<string, mixed>
 */
final class RecipeStep implements ArrayAccess, Countable, IteratorAggregate
{
    /**
     * Keys that the format holds for the reader of the recipe or for the runner of the step, which no op reads.
     */
    private const array ANNOTATIONS = ['op', 'only', 'reason', 'expect_unnamed'];

    /** @var array<string, true> */
    private array $read = [];

    private ?self $outcome = null;

    /**
     * @param array<string, mixed> $raw the step; with $database its expect of that database is read through a record
     * too.
     */
    public function __construct(private array $raw, ?string $database = null)
    {
        if ($database !== null && is_array($raw['expect'][$database] ?? null)) {
            $this->outcome = new self($raw['expect'][$database]);
            $this->raw['expect'][$database] = $this->outcome;
        }
    }

    public function offsetExists(mixed $offset): bool
    {
        $this->read[$offset] = true;
        return isset($this->raw[$offset]);
    }

    public function offsetGet(mixed $offset): mixed
    {
        $this->read[$offset] = true;
        return $this->raw[$offset];
    }

    public function offsetSet(mixed $offset, mixed $value): void
    {
        $this->raw[$offset] = $value;
    }

    public function offsetUnset(mixed $offset): void
    {
        unset($this->raw[$offset]);
    }

    /** Whether the key is present, null or not, as array_key_exists says of an array. */
    public function has(string $key): bool
    {
        $this->read[$key] = true;
        return array_key_exists($key, $this->raw);
    }

    /**
     * The whole value, for a compare that reads every key.
     *
     * @return array<string, mixed>
     */
    public function all(): array
    {
        $this->read = array_fill_keys(array_keys($this->raw), true);
        return $this->raw;
    }

    public function count(): int
    {
        return count($this->all());
    }

    public function getIterator(): Traversable
    {
        return new ArrayIterator($this->all());
    }

    /**
     * The keys that no read reached, the annotations aside.
     *
     * @return list<string>
     */
    private function unread(): array
    {
        $unread = array_values(array_diff(array_keys($this->raw), array_keys($this->read), self::ANNOTATIONS));
        foreach ($this->outcome?->unread() ?? [] as $key) {
            $unread[] = "expect.$key";
        }
        return $unread;
    }

    /** Fails the case by name on a key that the run did not read. */
    public function check(): void
    {
        $unread = $this->unread();
        if ($unread !== []) {
            Assert::fail('the helper did not read ' . implode(', ', $unread) . " of {$this->raw['op']}");
        }
    }

    /**
     * After an op that ended with its expected error: what the op did not reach is not asked of it, the outcome is.
     *
     * @param array<string, mixed> $expected
     */
    public function checkOutcome(array $expected, string ...$compared): void
    {
        $unread = array_values(array_diff(array_keys($expected), $compared));
        if ($unread !== []) {
            $names = implode(', ', array_map(static fn (string $key): string => "expect.$key", $unread));
            Assert::fail("the helper did not read $names of {$this->raw['op']}");
        }
    }
}
