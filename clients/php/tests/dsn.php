<?php
declare(strict_types=1);
require __DIR__ . '/../src/Db.php';
require __DIR__ . '/../src/Orm.php';
require __DIR__ . '/../src/Code.php';

foreach (['mysql://localhost/app', 'postgres://localhost/app', 'sqlite:///tmp/app.sqlite'] as $dsn) {
    $driver = \Orm\Db::driverFromDsn($dsn);
    if (!in_array($driver, ['mysql', 'postgres', 'sqlite'], true)) {
        throw new RuntimeException("wrong driver for $dsn");
    }
}
foreach (['mysqlx://localhost/app', 'relative/path', ''] as $dsn) {
    try {
        \Orm\Db::driverFromDsn($dsn);
        throw new RuntimeException("invalid DSN accepted: $dsn");
    } catch (\Orm\OrmException $e) {
        if ($e->code_ !== \Orm\Code::CONFIG) throw $e;
    }
}
echo "php DSN validation passed\n";
