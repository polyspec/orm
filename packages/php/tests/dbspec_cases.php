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

/**
 * Creates a fresh MySQL database or PostgreSQL schema and returns a session factory and cleanup operation.
 *
 * The session factory selects the new database or schema on every connection. Callers may supply a PDO subclass for
 * query counting; PostgreSQL cases with additional schemas may remove those through $beforeDrop and verify them through
 * $afterDrop. A PDO factory makes the SQL lifecycle testable without a server.
 *
 * @param Closure(string, ?string, ?string, array<int, mixed>): PDO|null $pdoFactory
 * @return array{0: Closure(): PDO, 1: Closure(): void}
 */
function dbspec_open_server_database(
    string $dialect,
    string $name,
    string $serverDsn,
    ?Closure $beforeDrop = null,
    ?Closure $afterDrop = null,
    ?Closure $pdoFactory = null
): array {
    if (!in_array($dialect, ['mysql', 'postgres'], true)) {
        throw new InvalidArgumentException("server database dialect $dialect");
    }
    [, $pdoDsn, $user, $password] = \Polyspec\Orm\Orm::parseDsn($serverDsn);
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    $open = $pdoFactory ?? static function (
        string $dsn,
        ?string $user,
        ?string $password,
        array $options
    ): PDO {
        return new PDO($dsn, $user, $password, $options);
    };
    $admin = $open($pdoDsn, $user, $password, $options);
    $quoted = $dialect === 'mysql' ? "`$name`" : "\"$name\"";
    $admin->exec(($dialect === 'mysql' ? 'CREATE DATABASE ' : 'CREATE SCHEMA ') . $quoted);
    $session = static function () use ($open, $pdoDsn, $user, $password, $options, $dialect, $quoted): PDO {
        $pdo = $open($pdoDsn, $user, $password, $options);
        $pdo->exec($dialect === 'mysql' ? "USE $quoted" : "SET search_path TO $quoted");
        return $pdo;
    };
    $drop = static function () use ($admin, $dialect, $quoted, $name, $beforeDrop, $afterDrop): void {
        $beforeDrop?->__invoke($admin, $name);
        $admin->exec(
            ($dialect === 'mysql' ? 'DROP DATABASE ' : 'DROP SCHEMA ') . $quoted
                . ($dialect === 'mysql' ? '' : ' CASCADE')
        );
        $left = $dialect === 'mysql'
            ? $admin->prepare('SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?')
            : $admin->prepare('SELECT COUNT(*) FROM pg_namespace WHERE nspname = ?');
        $left->execute([$name]);
        \PHPUnit\Framework\Assert::assertSame(0, (int) $left->fetchColumn(), "$dialect $name remains after cleanup");
        $afterDrop?->__invoke($admin, $name);
    };
    return [$session, $drop];
}
