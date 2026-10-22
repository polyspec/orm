<?php

// The writer process of SqliteConcurrencyTest: it commits $count read-then-write transactions on the SQLite file of
// $dsn without transaction retries, each reading the service count and then inserting one service named <name>-<i>.
// Usage: php packages/php/tests/sqlite_concurrency_writer.php <dsn> <name> <count>
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Config;
use Polyspec\Orm\Tests\Model\Service;

[, $dsn, $name, $count] = $argv;
try {
    $db = \Polyspec\Orm\Tests\Model\connect($dsn, new Config());
    for ($i = 0; $i < (int) $count; $i++) {
        $db->transaction(function () use ($name, $i): void {
            (new Service())->getCount();
            (new Service())->setName("$name-$i")->create();
        }, retry: 0);
    }
} catch (\Throwable $e) {
    fwrite(STDERR, get_class($e) . ': ' . $e->getMessage() . "\n");
    exit(1);
}
