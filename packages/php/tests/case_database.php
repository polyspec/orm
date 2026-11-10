<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// case database: the case's own database, used by one test case. The shared test database
// (the database of ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN) is not assumed to be empty, so a case that installs a
// schema or checks for an empty database uses a database with a non-overlapping name (MySQL, PostgreSQL) or
// a SQLite file, and removes it when the case ends (even after a failure). ORM_TEST_*_DSN is used only
// as the admin connection that creates and removes the database; nothing is created in that database.
// PostgreSQL also takes a database, not a schema: empty() counts a non-public schema as content.
// The calling script autoloads Polyspec\Orm\Orm.

use InvalidArgumentException;
use PDO;
use RuntimeException;
use Throwable;
use Polyspec\Orm\Internal\MarkdownPdoAdapter;
use Polyspec\Orm\MarkdownSession;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

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
            if ($this->driver === 'postgres') {
                $pdo->exec("DROP DATABASE {$this->name} WITH (FORCE)");
            } else {
                // One session with foreign_key_checks = 0 (DIA-212): a DROP DATABASE that MariaDB cannot finish logs
                // the tables it dropped as one DROP TABLE list under the checks of the session.
                // The session ends with the drop: $pdo is this call's own connection, closed when it is released.
                $pdo->exec('SET SESSION foreign_key_checks = 0');
                $pdo->exec("DROP DATABASE {$this->name}");
            }
            $pdo = null;
        } catch (Throwable $e) {
            throw new RuntimeException("drop database {$this->name}: {$e->getMessage()}", 0, $e);
        }
        ($this->step)("database {$this->name} dropped");
    }
}

/**
 * The PDO connection of the admin DSN. A corpus has no native driver but its flowmark server, which states SQL in
 * SQLite's dialect (DIA-185): its connection is one session of the server, as a native SQLite connection is one of
 * the file.
 */
function case_admin(string $dsn): PDO
{
    if (str_starts_with($dsn, 'markdown://')) {
        return markdown_session_pdo($dsn);
    }
    [, $pdoDsn, $user, $password] = Orm::parseDsn($dsn);
    return new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}

/** One session of the corpus of the markdown DSN $dsn, as the PDO handle of a SQLite connection. */
function markdown_session_pdo(string $dsn): PDO
{
    [$address, $corpus, $token] = Orm::parseMarkdownDsn($dsn);
    $dial = static fn(): MarkdownSession => MarkdownSession::dial($address, $corpus, $token);
    return new MarkdownPdoAdapter($dial(), $dial);
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
    // MariaDB is a server of the MySQL dialect (DIA-200): its case database is a MySQL one on the server of
    // ORM_TEST_MARIADB_DSN.
    if (!in_array($driver, ['mysql', 'mariadb', 'postgres'], true)) {
        throw new InvalidArgumentException("case database of driver $driver");
    }
    $env = 'ORM_TEST_' . strtoupper($driver) . '_DSN';
    $admin = getenv($env);
    if ($admin === false || $admin === '') {
        throw new RuntimeException(
            "$env is required; run make orm-test-servers, which starts the databases and writes it; run the test "
                . "through its make target, which reads the "
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
    if ($driver === 'markdown') {
        // The case database of a markdown connection is a corpus of no table.
        $result = null;
        CaseCorpus::with(null, static function (string $dsn) use ($body, &$result): void {
            $result = $body($dsn, null);
        });
        return $result;
    }
    $database = case_database($driver, $step);
    try {
        $result = $body($database->dsn, $database);
    } catch (Throwable $e) {
        try {
            $database->drop();
        } catch (Throwable $dropped) {
            $primary = new RuntimeException("{$e->getMessage()}; {$dropped->getMessage()}", 0, $e);
            throw OrmException::withCleanup($primary, $dropped);
        }
        throw $e;
    }
    $database->drop();
    return $result;
}

/**
 * The case of the drop of a case database of $driver (mysql or mariadb): it creates and drops a case database and
 * returns the foreign_key_checks of the next session of case_admin. The drop turns the checks of its session off
 * (DIA-212), and that session ends with the drop, so the next one has them on: CaseDatabaseMysqlTest and
 * CaseDatabaseMariadbTest assert 1 on the two servers of the MySQL dialect (DIA-200).
 *
 * @param callable(string): void $step
 */
function case_database_next_admin_checks(string $driver, callable $step): int
{
    case_database($driver, $step)->drop();
    $admin = getenv('ORM_TEST_' . strtoupper($driver) . '_DSN');
    if ($admin === false || $admin === '') {
        throw new RuntimeException('ORM_TEST_' . strtoupper($driver) . '_DSN is required');
    }
    $checks = case_admin($admin)->query('SELECT @@SESSION.foreign_key_checks');
    if ($checks === false) {
        throw new RuntimeException('read foreign_key_checks: no result');
    }
    return (int) $checks->fetchColumn();
}
