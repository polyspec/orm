<?php
// DSN parsing: the scheme selects the driver, the timezone parameter the connection zone.
// Usage: php clients/php/tests/dsn.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Code;
use Orm\Orm;
use Orm\OrmException;

function expect(bool $ok, string $message): void
{
    if (!$ok) {
        throw new RuntimeException($message);
    }
}

[$driver, $pdo, $user, $password, $zone, $zoneName] = Orm::parseDsn('mysql://app:p%40ss@db.local:3307/app?timezone=Asia%2FSeoul');
expect($driver === 'mysql' && $pdo === 'mysql:host=db.local;port=3307;dbname=app;charset=utf8mb4', "mysql pdo dsn: $pdo");
expect($user === 'app' && $password === 'p@ss', 'mysql credentials');
expect($zone->getName() === 'Asia/Seoul' && $zoneName === 'Asia/Seoul', 'timezone');
[, $pdo] = Orm::parseDsn('mysql://root@localhost/app?socket=/tmp/mysql.sock');
expect($pdo === 'mysql:unix_socket=/tmp/mysql.sock;dbname=app;charset=utf8mb4', "mysql socket: $pdo");
[$driver, $pdo, , , $zone] = Orm::parseDsn('postgres:///app?host=/tmp&timezone=%2B00:00');
expect($driver === 'postgres' && $pdo === 'pgsql:host=/tmp;port=5432;dbname=app' && $zone->getName() === '+00:00', "postgres: $pdo");
[$driver, $pdo] = Orm::parseDsn('sqlite:///tmp/app.sqlite?_pragma=busy_timeout(5000)');
expect($driver === 'sqlite' && $pdo === 'sqlite:/tmp/app.sqlite', "sqlite: $pdo");

foreach (['mysqlx://localhost/app', 'relative/path', '', 'sqlite://relative.sqlite', 'mysql://localhost/', 'postgres://localhost/app?timezone=Nowhere'] as $dsn) {
    try {
        Orm::parseDsn($dsn);
        throw new RuntimeException("invalid DSN accepted: $dsn");
    } catch (OrmException $e) {
        expect($e->code_ === Code::CONFIG, "wrong error for $dsn");
    }
}
foreach (['+09:00' => '<+09:00>-09:00', '-05:30' => '<-05:30>+05:30', '+00:00' => '<+00:00>-00:00', 'Asia/Seoul' => 'Asia/Seoul'] as $zone => $posix) {
    expect(Orm::postgresZone($zone) === $posix, "postgres zone $zone: " . Orm::postgresZone($zone));
}
echo "php DSN parsing passed\n";
