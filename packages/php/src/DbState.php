<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * @internal The state shared by all handles of one connection (Db and its withRequestHook handles).
 *           Only Db reads and writes it.
 */
final class DbState
{
    /**
     * The connection's PDO handle. A markdown connection and a closed connection have null; when that PDO
     * is released, the connection closes.
     */
    public ?\PDO $pdo = null;
    /** @var array<string, \PDOStatement> */
    public array $stmts = [];
    /** @var list<string> */
    public array $stmtOrder = [];
    public bool $closed = false;
    /**
     * Opens a LISTEN connection of its own, outside the connection's PDO handle (docs/spec/dialects.md DIA-194).
     * Orm::connect sets it for PostgreSQL only.
     *
     * @var (\Closure(): \PDO)|null
     */
    public ?\Closure $listener = null;
    /** The test fault that Polyspec\Orm\Testing\Faults::failNextRollback sets. Only that test entry point sets it. */
    public bool $rollbackFault = false;
    /**
     * The test fault that Polyspec\Orm\Testing\Faults::failNextStatement sets. It does not send the next
     * statement; it ends with this error. Only that test entry point sets it.
     */
    public ?OrmException $statementFault = null;
    /** The executor clock that Testing\Faults::fixClock fixed, or null for the wall clock. */
    public ?\DateTimeImmutable $fixedClock = null;
    /**
     * The affected count of the last successful write of the connection, or null before one;
     * Testing\Faults::lastAffected reads it.
     */
    public ?int $lastAffected = null;
    /** @var array<string, true> The manifest hashes of the sets registered on this connection. */
    public array $sets = [];
    /**
     * @var array<int, \Closure(StatementEvent): void> Statement event subscribers. In registration order;
     *      the key is the registration number.
     */
    public array $subscribers = [];
    public int $subscriberSeq = 0;
    /** The connection's outermost transaction number. Increases by one for each outermost begin. */
    public int $transactions = 0;
    /**
     * Whether the SQLite row lock table was created on this connection. Created once before the
     * connection's first transaction.
     */
    public bool $rowLockReady = false;
}
