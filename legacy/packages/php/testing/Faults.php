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
        self::state($db)->rollbackFault = true;
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
        self::state($db)->statementFault = new OrmException($code, $message);
    }

    /**
     * Pins the connection's executor clock to the $clock time. $clock is UTC text in the form `YYYY-MM-DD
     * HH:MM:SS.ffffff` (docs/spec/protocol.md "Test clock"). A different format is an \InvalidArgumentException and
     * nothing is set.
     */
    public static function fixClock(Db $db, string $clock): void
    {
        $t = preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/D', $clock) === 1
            ? \DateTimeImmutable::createFromFormat('!Y-m-d H:i:s.u', $clock, new \DateTimeZone('UTC'))
            : false;
        if ($t === false || $t->format('Y-m-d H:i:s.u') !== $clock) {
            throw new \InvalidArgumentException('fixClock needs a YYYY-MM-DD HH:MM:SS.ffffff clock');
        }
        self::state($db)->fixedClock = $t;
    }

    /**
     * The affected count of the last successful write on the connection. It is null if there was no successful write
     * (docs/spec/protocol.md "Test write result").
     */
    public static function lastAffected(Db $db): ?int
    {
        return self::state($db)->lastAffected;
    }

    /**
     * The connection state of the Db. The state is private to Db, and a closure cannot be bound to the scope of the
     * extension's internal Db, so it is read by reflection.
     */
    private static function state(Db $db): \Polyspec\Orm\DbState
    {
        return (new \ReflectionProperty(Db::class, 'state'))->getValue($db);
    }
}
