<?php

declare(strict_types=1);

namespace Polyspec\Orm;

final class OrmException extends \RuntimeException
{
    /**
     * @param ?\Throwable $rollback the rollback error of a ROLLBACK error, whose
     *     previous exception is the callback error
     */
    public function __construct(
        public readonly string $code_,
        string $message,
        ?\Throwable $previous = null,
        public readonly ?\Throwable $rollback = null
    )
    {
        parent::__construct($code_ . ': ' . $message, 0, $previous);
    }

    /**
     * The error when a transaction's or savepoint's work fails and its rollback fails too.
     * It holds the cause as previous, and the rollback error as rollback.
     */
    public static function rollback(\Throwable $cause, \Throwable $rollback): self
    {
        return new self(Code::ROLLBACK,
            'transaction failed (' . $cause->getMessage() . ') and rollback failed (' . $rollback->getMessage() . ')',
            $cause, $rollback);
    }

    /**
     * Reports a driver error with the code the error catalog names for it,
     * and every other driver error with DRIVER. The exception keeps the driver
     * message and the driver error as its previous exception. $pdo is the
     * connection the error came from.
     */
    public static function fromDriver(\PDOException $e, string $driver, \PDO $pdo): self
    {
        $state = (string) ($e->errorInfo[0] ?? $e->getCode());
        $num = $e->errorInfo[1] ?? null;
        $message = (string) ($e->errorInfo[2] ?? '');
        $code = match ($driver) {
            'postgres' => match (true) {
                // Class 08 is connection exception. 57P01 (admin_shutdown) and 57P02 (crash_shutdown),
                // and 57P05 (idle_session_timeout), are sent by the server when it ends the session. When libpq
                // loses the connection, it arrives as HY000 with no SQLSTATE from the server, and libpq reports the
                // backend pid of a closed connection as 0.
                str_starts_with($state, '08'), in_array($state, ['57P01', '57P02', '57P05'], true),
                $state === 'HY000' && $pdo instanceof \Pdo\Pgsql && $pdo->getPid() === 0 => Code::CONNECTION_LOST,
                default => self::postgresCode($state),
            },
            'sqlite' => match (true) {
                // SQLITE_BUSY: another connection held the lock when busy_timeout ended.
                is_int($num) && ($num & 0xff) === 5 => Code::CANCELED,
                in_array($num, [6, 262], true) => Code::DEADLOCK,
                in_array($num, [2067, 1555], true)
                    || ($num === 19 && str_starts_with($message, 'UNIQUE constraint failed')) => Code::DUPLICATE_KEY,
                // A FK violation of a RESTRICT action comes as CONSTRAINT_TRIGGER (1811). The 1811 from a trigger
                // RAISE is DRIVER.
                $num === 787
                    || (in_array($num, [19, 1811], true) && str_starts_with($message, 'FOREIGN KEY constraint failed'))
                    => Code::FOREIGN_KEY,
                $num === 275
                    || ($num === 19 && str_starts_with($message, 'CHECK constraint failed')) => Code::CONSTRAINT,
                $num === 9 => Code::CANCELED,
                is_int($num) && ($num & 0xff) === 8 => Code::READ_ONLY,
                default => Code::DRIVER,
            },
            default => match (true) {
                $num === 3572 || $state === 'ER_LOCK_NOWAIT' => Code::LOCK_NOT_AVAILABLE,
                $num === 1213 || $state === '40001' => Code::DEADLOCK,
                $num === 1062 || ($num === null && $state === '23000') => Code::DUPLICATE_KEY,
                $num === 1451 || $num === 1452 => Code::FOREIGN_KEY,
                $num === 1317 || $num === 3024 => Code::CANCELED,
                $num === 1290 || $num === 1792 => Code::READ_ONLY,
                $num === 3819 || $num === 4025 => Code::CONSTRAINT,
                // 2006 (server has gone away) and 2013 (lost connection during query) mean the client lost the
                // connection, and 4031 means the server ended an idle connection.
                $num === 2006 || $num === 2013 || $num === 4031 => Code::CONNECTION_LOST,
                default => Code::DRIVER,
            },
        };
        return new self($code, $e->getMessage(), $e);
    }

    /** The code of a PostgreSQL error that the server reported as SQLSTATE. */
    private static function postgresCode(string $state): string
    {
        return match ($state) {
            '55P03' => Code::LOCK_NOT_AVAILABLE,
            '40P01', '40001' => Code::DEADLOCK,
            '23505' => Code::DUPLICATE_KEY,
            '23503' => Code::FOREIGN_KEY,
            '57014' => Code::CANCELED,
            '25006' => Code::READ_ONLY,
            '23514' => Code::CONSTRAINT,
            default => Code::DRIVER,
        };
    }
}
