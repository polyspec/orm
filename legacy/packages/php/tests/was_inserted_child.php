<?php

// The waiting side of WasInsertedTest::testPostgresReportsABackendWaitingForLock. It updates the row that the
// parent transaction holds, so it blocks until the parent ends its transaction, then prints "done". Its session
// reports its lock waits (T475): with deadlock_timeout 1 ms, log_lock_waits on and client_min_messages log, the server
// sends it the LOG message "still waiting for" once the update has waited 1 ms for the lock, while it still waits, and
// the notice callback prints "waiting" on that message.
// Usage: php was_inserted_child.php <postgres dsn> <seq>
declare(strict_types=1);

require __DIR__ . '/autoload.php';

[, $dsn, $seq] = $argv;
[, $pdoDsn, $user, $password] = Polyspec\Orm\Orm::parseDsn($dsn);
$pdo = new Pdo\Pgsql($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
foreach (["SET deadlock_timeout = '1ms'", 'SET log_lock_waits = on', 'SET client_min_messages = log'] as $setting) {
    $pdo->exec($setting);
}
$reported = false;
$pdo->setNoticeCallback(static function (string $message) use (&$reported): void {
    if (!$reported && str_contains($message, 'still waiting for')) {
        $reported = true;
        fwrite(STDOUT, "waiting\n");
        fflush(STDOUT);
    }
});
$pdo->beginTransaction();
$pdo->exec('UPDATE clock_event SET label = \'child\' WHERE seq = ' . (int) $seq);
$pdo->commit();
fwrite(STDOUT, "done\n");
