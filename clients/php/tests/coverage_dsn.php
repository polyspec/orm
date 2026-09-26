<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Code;
use Orm\Config;
use Orm\Orm;
use Orm\OrmException;

if ($argc !== 2 || $argv[1] !== 'dsn_connection') {
    throw new RuntimeException('usage: coverage_dsn.php dsn_connection');
}
$driver = getenv('ORM_FEATURE_DATABASE');
$dsn = getenv('ORM_FEATURE_DSN');
if (!is_string($driver) || !in_array($driver, ['mysql', 'postgres', 'sqlite'], true) || !is_string($dsn) || $dsn === '') {
    throw new RuntimeException('selected database and DSN are required');
}
try {
    Orm::parseDsn('invalid://database');
    throw new RuntimeException('unsupported DSN scheme was accepted');
} catch (OrmException $error) {
    if ($error->code_ !== Code::CONFIG) {
        throw $error;
    }
}
$root = dirname(__DIR__, 3);
$db = Orm::connect($dsn, new Config(schemaPath: "$root/schema/schema.json"));
try {
    if ($db->driver() !== $driver || (int) $db->pdo()->query('SELECT 1')->fetchColumn() !== 1) {
        throw new RuntimeException('DSN selected the wrong database or connection');
    }
} finally {
    $db->close();
}
echo "CASE dsn_connection PASS\n";
