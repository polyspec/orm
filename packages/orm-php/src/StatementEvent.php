<?php
declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * One statement that the connection sent to the database (docs/usage.md
 * "Statement events"). Db::subscribe registers the subscribers that receive
 * it after the statement ends and before the operation continues.
 */
final readonly class StatementEvent
{
    public const SELECT = 'select';
    public const INSERT = 'insert';
    public const UPDATE = 'update';
    public const DELETE = 'delete';
    public const BEGIN = 'begin';
    public const COMMIT = 'commit';
    public const ROLLBACK = 'rollback';
    public const SAVEPOINT = 'savepoint';
    public const RELEASE = 'release';
    public const ROLLBACK_TO = 'rollback_to';
    public const SCHEMA = 'schema';
    public const UTILITY = 'utility';

    /**
     * @param list<mixed> $binds the bound values in order; a secret is "$SECRET" and an executor clock value "$NOW"
     * @param list<string> $tables the tables the statement names, sorted; transaction control names none
     * @param float $elapsed seconds from sending the statement until its result was read
     * @param ?int $transaction the number of the transaction of the connection, counted from 1 by every outermost begin; null outside a transaction
     * @param ?OrmException $error the error the statement ended with
     */
    public function __construct(
        public string $sql,
        public array $binds,
        public string $kind,
        public array $tables,
        public float $elapsed,
        public ?int $transaction,
        public ?OrmException $error,
    ) {
    }
}
