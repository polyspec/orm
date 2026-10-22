<?php

declare(strict_types=1);

namespace Polyspec\Orm;

/**
 * LISTEN and NOTIFY on PostgreSQL (docs/spec/dialects.md DIA-192 to DIA-196, PRT-74). Db::notify and Db::listen call these
 * functions, and so does the C extension, so the rules are written once.
 *
 * @internal
 */
final class Listen
{
    /** Sends payload to channel with pg_notify on the connection of $db (DIA-193). */
    public static function notify(Db $db, string $channel, string $payload): void
    {
        self::requirePostgres($db, 'notify');
        Subscription::checkChannel($channel);
        $st = $db->pdo()->prepare('SELECT pg_notify(?, ?)');
        try {
            $st->execute([$channel, $payload]);
        } catch (\PDOException $e) {
            throw $db->driverError($e);
        }
        $st->closeCursor();
    }

    /** Opens a LISTEN subscription on channel on a connection of its own, outside the connection's PDO (DIA-194). */
    public static function listen(Db $db, string $channel): Subscription
    {
        self::requirePostgres($db, 'listen');
        Subscription::checkChannel($channel);
        $open = $db->listener();
        if ($open === null) {
            throw new OrmException(Code::CONFIG, 'database is closed');
        }
        try {
            $pdo = $open();
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $pdo->exec('LISTEN ' . Subscription::quoteIdent($channel));
        } catch (\PDOException $e) {
            throw $db->driverError($e);
        }
        return new Subscription($pdo);
    }

    /** LISTEN and NOTIFY exist on PostgreSQL only (DIA-196): another database refuses them before a statement runs. */
    private static function requirePostgres(Db $db, string $surface): void
    {
        if ($db->driver() !== 'postgres') {
            throw new OrmException(Code::CAPABILITY_UNSUPPORTED, "$surface is supported on PostgreSQL only");
        }
    }
}
