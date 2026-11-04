<?php

declare(strict_types=1);

use PHPUnit\Framework\Assert;

/** The statements that each dbspec test runs on a fresh connection to its selected database. */
function dbspec_connection_rules(): array
{
    return [
        'mysql' => ["SET time_zone = '+00:00'"],
        'postgres' => ["SET TimeZone = 'UTC'"],
        'sqlite' => ['PRAGMA foreign_keys = ON'],
    ];
}

/**
 * @param array{mysql: string, postgres: string} $names
 * @return array{mysql: string, postgres: string}
 */
function dbspec_dsns(array $names, ?string $missingMessage = null): array
{
    $dsns = [];
    foreach ($names as $driver => $name) {
        if ($missingMessage === null) {
            $dsns[$driver] = requiredDsn($name);
            continue;
        }
        $dsn = getenv($name);
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException($missingMessage);
        }
        $dsns[$driver] = $dsn;
    }
    return $dsns;
}

/** Reads a query's first value as text; the plan fixture also records SQL NULL as `NULL`. */
function dbspec_value(PDO $pdo, string $query, bool $nullAsText = false): string
{
    $rows = $pdo->query($query)->fetchAll(PDO::FETCH_NUM);
    Assert::assertNotSame([], $rows, "$query: no row");
    $value = $rows[0][0];
    return match (true) {
        $value === null && $nullAsText => 'NULL',
        is_string($value) => $value,
        is_int($value) => (string) $value,
        default => throw new RuntimeException(
            "$query: value of type " . get_debug_type($value) . ' has no text form here'
        ),
    };
}

/** Removes a SQLite test database and every sidecar file it can leave. */
function dbspec_remove_sqlite_files(string $path): void
{
    foreach (['', '-journal', '-wal', '-shm'] as $suffix) {
        if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
            throw new RuntimeException("$path$suffix cannot be removed");
        }
    }
}
