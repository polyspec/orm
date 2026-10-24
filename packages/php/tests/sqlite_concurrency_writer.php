<?php

// The writer process of SqliteConcurrencyTest: it commits $count read-then-write transactions on the SQLite file of
// $dsn without transaction retries, each reading the service count and then inserting one service named <name>-<i>.
// Usage: php packages/php/tests/sqlite_concurrency_writer.php <dsn> <name> <count>
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once __DIR__ . '/SqliteConcurrencyWriter.php';

use Polyspec\Orm\Config;

[, $dsn, $name, $count] = $argv;
try {
    $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
    \Polyspec\Orm\Tests\SqliteConcurrencyWriter::writeServices($db, $name, (int) $count);
} catch (\Throwable $e) {
    fwrite(STDERR, get_class($e) . ': ' . $e->getMessage() . "\n");
    exit(1);
}
