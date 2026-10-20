<?php

declare(strict_types=1);

namespace Polyspec\Orm\Testing;

use Polyspec\Orm\Db;
use Polyspec\Orm\OrmException;

/**
 * Test entry point of the PHP client. The package autoloader does not map this file, so a
 * process has this class only after it requires the package's `testing/Faults.php` by path,
 * and holds it.
 */
final class Faults
{
    /**
     * Sets a test fault on the connection: after the callback fails, the transaction's
     * rollback runs and then reports a FAULT error as a rollback error, so the transaction
     * throws the callback error and a ROLLBACK error carrying the fault. The fault stays
     * until a rollback consumes it.
     */
    public static function failNextRollback(Db $db): void
    {
        (\Closure::bind(static function (Db $db): void {
            $db->state->rollbackFault = true;
        }, null, Db::class))($db);
    }

    /**
     * Sets a statement fault on the connection: the next statement (excluding transaction control statements)
     * is not sent and ends with an OrmException carrying $code and $message. That statement consumes the fault.
     * An already set statement fault is replaced. If code or message is empty, it is an \InvalidArgumentException and
     * nothing is set.
     */
    public static function failNextStatement(Db $db, string $code, string $message): void
    {
        if ($code === '') {
            throw new \InvalidArgumentException('failNextStatement needs a nonempty code');
        }
        if ($message === '') {
            throw new \InvalidArgumentException('failNextStatement needs a nonempty message');
        }
        (\Closure::bind(static function (Db $db) use ($code, $message): void {
            $db->state->statementFault = new OrmException($code, $message);
        }, null, Db::class))($db);
    }

    /**
     * Pins the connection's executor clock to the $clock time. $clock is UTC text in the form `YYYY-MM-DD HH:MM:SS.ffffff`
     * (docs/spec/protocol.md "Test clock"). A different format is an \InvalidArgumentException and nothing is set.
     */
    public static function fixClock(Db $db, string $clock): void
    {
        $t = preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/D', $clock) === 1
            ? \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $clock, new \DateTimeZone('UTC'))
            : false;
        if ($t === false || $t->format('Y-m-d H:i:s.u') !== $clock) {
            throw new \InvalidArgumentException('fixClock needs a YYYY-MM-DD HH:MM:SS.ffffff clock');
        }
        (\Closure::bind(static function (Db $db) use ($t): void {
            $db->state->fixedClock = $t;
        }, null, Db::class))($db);
    }

    /**
     * The affected count of the last successful write on the connection. It is null if there was no successful write
     * (docs/spec/protocol.md "Test write result").
     */
    public static function lastAffected(Db $db): ?int
    {
        return (\Closure::bind(static fn(Db $db): ?int => $db->state->lastAffected, null, Db::class))($db);
    }
}
