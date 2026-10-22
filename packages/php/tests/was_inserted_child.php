<?php

// The waiting side of WasInsertedTest::test_postgres_reports_a_backend_waiting_for_lock. It updates the row that the
// parent transaction holds, so it blocks until the parent ends its transaction, then prints "done".
// Usage: php was_inserted_child.php <postgres dsn> <seq>
declare(strict_types=1);

require __DIR__ . '/autoload.php';

[, $dsn, $seq] = $argv;
[, $pdoDsn, $user, $password] = Polyspec\Orm\Orm::parseDsn($dsn);
$pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->beginTransaction();
$pdo->exec('UPDATE clock_event SET label = \'child\' WHERE seq = ' . (int) $seq);
$pdo->commit();
fwrite(STDOUT, "done\n");
