<?php

declare(strict_types=1);

// case database: the case's own database, used by one test case. The shared test database
// (the database of ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN) is not assumed to be empty, so a case that installs a
// schema or checks for an empty database uses a database with a non-overlapping name (MySQL, PostgreSQL) or
// a SQLite file, and removes it when the case ends (even after a failure). ORM_TEST_*_DSN is used only
// as the admin connection that creates and removes the database; nothing is created in that database.
// PostgreSQL also takes a database, not a schema: empty() counts a non-public schema as content.
// The calling script autoloads Polyspec\Orm\Orm.

use Polyspec\Orm\Orm;

/** A non-overlapping name orm_case_<pid>_<counter> per process. The counter counts from 1. */
function case_name(): string
{
    static $counter = 0;
    $counter++;
    return 'orm_case_' . getmypid() . '_' . $counter;
}

/** Changes the DSN's path (the database name) to $name. The query is left as it is. */
function case_dsn_with_database(string $dsn, string $name): string
{
    $replaced = preg_replace('~^([a-z]+://[^/?#]*)(/[^?#]*)?~', '${1}/' . $name, $dsn, 1, $count);
    if ($replaced === null || $count !== 1) {
        throw new InvalidArgumentException('a DSN without a scheme and authority');
    }
    return $replaced;
}

final class CaseDatabase
{
    private bool $dropped = false;

    /** @param callable(string): void $step */
    public function __construct(
        public readonly string $driver,
        public readonly string $name,
        public readonly string $dsn,
        private readonly ?string $admin,
        private $step,
    ) {
    }

    /** Changes the DSN of another server (replica) to this database name. */
    public function related(string $dsn): string
    {
        return case_dsn_with_database($dsn, $this->name);
    }

    /** Removes the database or SQLite file. A second call does nothing. */
    public function drop(): void
    {
        if ($this->dropped) {
            return;
        }
        $this->dropped = true;
        if ($this->driver === 'sqlite') {
            foreach (['', '-wal', '-shm', '-journal'] as $suffix) {
                $file = $this->name . $suffix;
                if (file_exists($file) && !unlink($file)) {
                    throw new RuntimeException("drop sqlite file $file: unlink failed");
                }
            }
            ($this->step)("database file {$this->name} removed");
            return;
        }
        try {
            $pdo = case_admin($this->admin);
            $pdo->exec("DROP DATABASE {$this->name}" . ($this->driver === 'postgres' ? ' WITH (FORCE)' : ''));
        } catch (Throwable $e) {
            throw new RuntimeException("drop database {$this->name}: {$e->getMessage()}", 0, $e);
        }
        ($this->step)("database {$this->name} dropped");
    }
}

/** The PDO connection of the admin DSN. */
function case_admin(string $dsn): PDO
{
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/**
 * Creates a new case database for $driver and reports it with $step. MySQL and PostgreSQL make a database on the server
 * of ORM_TEST_<DRIVER>_DSN, and SQLite makes a file in a temp directory. The caller calls drop().
 *
 * @param callable(string): void $step callable that reports the case's steps (the test passes a callable that does
 *   nothing)
 */
function case_database(string $driver, callable $step): CaseDatabase
{
    $name = case_name();
    if ($driver === 'sqlite') {
        $path = sys_get_temp_dir() . '/' . str_replace('_', '-', $name) . '.sqlite';
        if (file_exists($path) || !touch($path)) {
            throw new RuntimeException("create sqlite file $path: the file exists or cannot be created");
        }
        $step("database file $path created");
        return new CaseDatabase($driver, $path, "sqlite://$path", null, $step);
    }
    if (!in_array($driver, ['mysql', 'postgres'], true)) {
        throw new InvalidArgumentException("case database of driver $driver");
    }
    $env = 'ORM_TEST_' . strtoupper($driver) . '_DSN';
    $admin = getenv($env);
    if ($admin === false || $admin === '') {
        throw new RuntimeException(
            "$env is required; database tests never skip; run the test through its make target, which reads the "
            . "environment of make orm-test-servers"
        );
    }
    try {
        case_admin($admin)->exec("CREATE DATABASE $name");
    } catch (Throwable $e) {
        throw new RuntimeException("create database $name: {$e->getMessage()}", 0, $e);
    }
    $step("database $name created");
    return new CaseDatabase($driver, $name, case_dsn_with_database($admin, $name), $admin, $step);
}

/**
 * Runs $body with the DSN of the new case database, and removes the database whether it succeeds or fails. If removal
 * fails, it fails with that database name, and if $body also failed, it includes both reasons.
 *
 * @param callable(string): void $step
 * @param callable(string, CaseDatabase): mixed $body
 */
function with_case_database(string $driver, callable $step, callable $body): mixed
{
    $database = case_database($driver, $step);
    try {
        $result = $body($database->dsn, $database);
    } catch (Throwable $e) {
        try {
            $database->drop();
        } catch (Throwable $dropped) {
            throw new RuntimeException("{$e->getMessage()}; {$dropped->getMessage()}", 0, $e);
        }
        throw $e;
    }
    $database->drop();
    return $result;
}
