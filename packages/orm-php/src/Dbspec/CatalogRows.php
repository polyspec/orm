<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * introspection 의 catalog query 를 보내고 그 값을 읽는다. query 실패와 catalog 가
 * 선언하지 않은 모양의 값은 query 를 담은 error 다.
 *
 * @internal
 */
final class CatalogRows
{
    /** @var ?\Closure(string, int, ?\Throwable): void observed가 정한 catalog query observer다. */
    private static ?\Closure $observer = null;

    /**
     * $fn 동안 catalog query 마다 $observer 를 부른다. observer 는 query 의 row 를 모두
     * 읽었거나 읽다 실패했을 때 query, query 를 보내기 전의 hrtime, query 의 오류(성공이면
     * null)를 받는다. observer 가 던진 오류는 introspection 을 그 오류로 끝낸다.
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
     * query 의 모든 row 를 위치 순 값으로 돌려준다. connection 의 error mode 와
     * 무관하게 실패는 RuntimeException 이다.
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

    /** boolean 이나 0, 1 인 값. @param list<mixed> $row */
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
