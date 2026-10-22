<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\Orm\Dbspec\CatalogRows;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\DocumentSet;
use Polyspec\Orm\Dbspec\Renderer;

/** Operations outside the query syntax: `$db->utils()`. */
final class Utils
{
    public function __construct(private readonly Db $db)
    {
    }

    /**
     * @internal the active transaction of the connection; CONFIG names $name when there is none.
     * SchemaUtils, PrivilegeUtils and AesUtils reach the helpers through the Utils they hold.
     */
    public function active(string $name): TxFrame
    {
        return Db::activeFor($this->db) ?? throw new OrmException(
            Code::CONFIG,
            "$name requires an active transaction of the connection"
        );
    }

    /** @internal runs $fn in the active transaction of the connection or in a new one without retry */
    public function run(\Closure $fn): mixed
    {
        if (Db::activeFor($this->db) !== null) {
            return $fn();
        }
        return $this->db->transaction($fn, retry: 0);
    }

    /**
     * @internal the first column of the first row of a statement, read through the active
     * transaction or the connection; false without a row. The statement publishes its event with
     * $kind and $tables.
     *
     * @param list<string> $tables
     */
    public function read(string $kind, array $tables, string $sql, array $args): mixed
    {
        $rows = $this->db->fetch($kind, $tables, $this->db->transactionNumber(), $sql, $args);
        return $rows === [] ? false : $rows[0][0];
    }

    /**
     * @internal runs a statement through the active transaction or the connection and publishes
     * its event with $kind and $tables
     *
     * @param list<string> $tables
     */
    public function exec(string $kind, array $tables, string $sql, array $args = []): void
    {
        $this->db->fetch($kind, $tables, $this->db->transactionNumber(), $sql, $args);
    }

    private static function validKey(string $key): bool
    {
        return strlen($key) <= 64 && preg_match('/^[A-Za-z0-9_][A-Za-z0-9_.]*$/', $key) === 1;
    }

    /** Takes a named lock that is released when the transaction ends. */
    public function lock(string $key): void
    {
        $this->db->unsupportedOnMarkdown('lock');
        $frame = $this->active('lock');
        if (!self::validKey($key)) {
            throw new OrmException(Code::CONFIG, "lock key $key is invalid");
        }
        switch ($this->db->driver()) {
            case 'mysql':
                $got = $this->db->fetch(
                    StatementEvent::UTILITY,
                    [],
                    $frame->number,
                    'SELECT GET_LOCK(?, 50)',
                    [$key]
                )[0][0] ?? null;
                if ((int) $got !== 1) {
                    throw Orm::transactionConflict("lock $key was not acquired");
                }
                $frame->locks[] = $key;
                break;
            case 'postgres':
                $this->db->fetch(
                    StatementEvent::UTILITY,
                    [],
                    $frame->number,
                    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                    [$key]
                );
                break;
            default:
                $this->db->acquireSQLiteRowLock('update');
        }
    }

    /**
     * Sets the transaction-local value. PostgreSQL uses set_config, and MySQL uses user
     * variables; SQLite holds the value only inside a transaction.
     */
    public function setLocal(string $key, string $value): void
    {
        $this->db->unsupportedOnMarkdown('setLocal');
        $frame = $this->active('setLocal');
        if (!self::validKey($key)) {
            throw new OrmException(Code::CONFIG, "local key $key is invalid");
        }
        switch ($this->db->driver()) {
            case 'postgres':
                $this->db->fetch(
                    StatementEvent::UTILITY,
                    [],
                    $frame->number,
                    'SELECT set_config($1, $2, true)',
                    [$key, $value]
                );
                break;
            case 'mysql':
                $this->db->fetch(StatementEvent::UTILITY, [], $frame->number, 'SET @`orm.' . $key . '` = ?', [$value]);
                break;
        }
        $frame->locals[$key] = $value;
    }

    /** A value set with setLocal(); NO_ROWS when it is missing. */
    public function local(string $key): string
    {
        $this->db->unsupportedOnMarkdown('local');
        $frame = $this->active('local');
        return $frame->locals[$key] ?? throw new OrmException(Code::NO_ROWS, "local value $key is not set");
    }

    /**
     * Whether a generated insert of $entity with the identity key $sequence succeeded in the active transaction
     * (INT-52). The fact is restored across savepoint rollback and is the same on every dialect.
     */
    public function wasInserted(string $entity, int $sequence): bool
    {
        $frame = $this->active('wasInserted');
        if ($entity === '' || $sequence <= 0) {
            throw new OrmException(Code::CONFIG, 'inserted entity and positive key are required');
        }
        return isset($frame->inserted[$entity][$sequence]);
    }

    /**
     * Whether another backend of the PostgreSQL connection waits for a lock (INT-53). MySQL and SQLite return false
     * without a statement.
     */
    public function backendWaitingForLock(): bool
    {
        $this->db->unsupportedOnMarkdown('backendWaitingForLock');
        if ($this->db->driver() !== 'postgres') {
            return false;
        }
        // pg_stat_activity is a snapshot per transaction: the statistics are cleared first, so that a backend that
        // starts to wait after the transaction has read the view is seen.
        $this->read(StatementEvent::UTILITY, [], 'SELECT pg_stat_clear_snapshot()', []);
        $waiting = $this->read(
            StatementEvent::UTILITY,
            [],
            'SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE '
            . 'a.datname=current_database() AND a.pid<>pg_backend_pid() AND NOT l.granted)',
            []
        );
        return $waiting === true || $waiting === 't' || $waiting === '1' || $waiting === 1;
    }

    public function schema(): SchemaUtils
    {
        return new SchemaUtils($this->db, $this);
    }

    public function privileges(): PrivilegeUtils
    {
        return new PrivilegeUtils($this->db, $this);
    }

    public function aes(): AesUtils
    {
        return new AesUtils($this->db, $this);
    }

    /** The connection state of the Db (Db::stats). */
    public function stats(): Stats
    {
        return $this->db->stats();
    }
}
