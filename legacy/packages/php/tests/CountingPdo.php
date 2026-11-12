<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOStatement;

/**
 * Counts the catalog queries sent by introspection: on its own connection, or on a connection it wraps, such as one
 * session of a flowmark server, which has no PDO DSN (over).
 */
final class CountingPdo extends PDO
{
    public int $queries = 0;

    private ?PDO $inner = null;

    /** Counts the queries sent on $inner. */
    public static function over(PDO $inner): self
    {
        $counting = (new \ReflectionClass(self::class))->newInstanceWithoutConstructor();
        $counting->inner = $inner;
        return $counting;
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        $this->queries++;
        if ($this->inner !== null) {
            return $fetchMode === null
                ? $this->inner->query($query)
                : $this->inner->query($query, $fetchMode, ...$fetchModeArgs);
        }
        return parent::query($query, $fetchMode, ...$fetchModeArgs);
    }

    public function exec(string $statement): int|false
    {
        return $this->inner !== null ? $this->inner->exec($statement) : parent::exec($statement);
    }

    public function prepare(string $query, array $options = []): PDOStatement|false
    {
        return $this->inner !== null ? $this->inner->prepare($query, $options) : parent::prepare($query, $options);
    }

    public function getAttribute(int $attribute): mixed
    {
        return $this->inner !== null ? $this->inner->getAttribute($attribute) : parent::getAttribute($attribute);
    }

    public function errorInfo(): array
    {
        return $this->inner !== null ? $this->inner->errorInfo() : parent::errorInfo();
    }
}
