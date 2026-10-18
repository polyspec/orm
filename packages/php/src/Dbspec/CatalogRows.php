<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * Sends the introspection catalog queries and reads their values. A query failure and a catalog
 * value of a shape it did not declare are errors carrying the query.
 *
 * @internal
 */
final class CatalogRows
{
    /** @var ?\Closure(string, int, ?\Throwable): void The catalog query observer that observed sets. */
    private static ?\Closure $observer = null;

    /**
     * Calls $observer for each catalog query while $fn runs. The observer receives all of the query's rows once
     * they have been read or reading has failed, the query, the hrtime before the query was sent, and the query's error (null on success).
     * An exception the observer throws ends introspection with that error.
     *
     * @template T
     * @param \Closure(string, int, ?\Throwable): void $observer
     * @param \Closure(): T $fn
     * @return T
     */
    public static function observed(\Closure $observer, \Closure $fn): mixed
    {
        $previous = self::$observer;
        self::$observer = $observer;
        try {
            return $fn();
        } finally {
            self::$observer = $previous;
        }
    }

    /**
     * Returns all rows of the query as position-ordered values. Regardless of the connection's error mode,
     * a failure is a RuntimeException.
     *
     * @return list<list<mixed>>
     */
    public static function read(\PDO $connection, string $query): array
    {
        $start = hrtime(true);
        $rows = [];
        $failure = null;
        try {
            $statement = $connection->query($query, \PDO::FETCH_NUM);
            if ($statement === false) {
                $failure = new \RuntimeException(self::failure($query, $connection->errorInfo()));
            } else {
                $rows = $statement->fetchAll();
                if ($statement->errorCode() !== '00000') {
                    $failure = new \RuntimeException(self::failure($query, $statement->errorInfo()));
                }
            }
        } catch (\PDOException $e) {
            $failure = $e;
        }
        if (self::$observer !== null) {
            (self::$observer)($query, $start, $failure);
        }
        if ($failure instanceof \PDOException) {
            throw new \RuntimeException("Catalog query failed: {$failure->getMessage()}\n$query", 0, $failure);
        }
        if ($failure !== null) {
            throw $failure;
        }
        return $rows;
    }

    /** @param array<int, mixed> $info */
    private static function failure(string $query, array $info): string
    {
        return 'Catalog query failed: SQLSTATE[' . ($info[0] ?? '') . '] ' . ($info[2] ?? '') . "\n$query";
    }

    /** @param list<mixed> $row */
    public static function text(array $row, int $i, string $query): string
    {
        $value = $row[$i] ?? null;
        if (!is_string($value)) {
            throw new \UnexpectedValueException("Catalog value $i is " . get_debug_type($value) . ', not a string, in ' . self::firstLine($query));
        }
        return $value;
    }

    /** @param list<mixed> $row */
    public static function nullableText(array $row, int $i, string $query): ?string
    {
        return ($row[$i] ?? null) === null ? null : self::text($row, $i, $query);
    }

    /** @param list<mixed> $row */
    public static function integer(array $row, int $i, string $query): int
    {
        $value = $row[$i] ?? null;
        if (is_int($value)) {
            return $value;
        }
        if (is_string($value) && preg_match('/^-?[0-9]+$/D', $value)) {
            return (int) $value;
        }
        throw new \UnexpectedValueException("Catalog value $i is " . get_debug_type($value) . ', not an integer, in ' . self::firstLine($query));
    }

    /** A value that is boolean, or 0 or 1. @param list<mixed> $row */
    public static function flag(array $row, int $i, string $query): bool
    {
        $value = $row[$i] ?? null;
        if (is_bool($value)) {
            return $value;
        }
        if ($value === 0 || $value === '0') {
            return false;
        }
        if ($value === 1 || $value === '1') {
            return true;
        }
        throw new \UnexpectedValueException("Catalog value $i is " . var_export($value, true) . ', not a boolean, in ' . self::firstLine($query));
    }

    private static function firstLine(string $query): string
    {
        return strtok($query, "\n");
    }
}
