<?php

declare(strict_types=1);

use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;

require dirname(__DIR__, 3) . '/vendor-php/autoload.php';

[$script, $dsn, $table, $lock] = $argv;
$db = Orm::connect($dsn, new Config());
$db->transaction(static function () use ($db, $table, $lock): void {
    $db->utils()->lock($lock);
    $db->fetch('write', [], $db->transactionNumber(), "INSERT INTO `$table` (id) VALUES (1)");
    exit(0);
}, retry: 0);
