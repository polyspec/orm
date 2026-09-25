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

[$driver, $pdo, $user, $password, $zone, $zoneName] = Orm::parseDsn('mysql://orm:p%40ss@db.local:3307/orm_example?timezone=Asia%2FSeoul');
expect($driver === 'mysql' && $pdo === 'mysql:host=db.local;port=3307;dbname=orm_example;charset=utf8mb4', "mysql pdo dsn: $pdo");
expect($user === 'orm' && $password === 'p@ss', 'mysql credentials');
expect($zone->getName() === 'Asia/Seoul' && $zoneName === 'Asia/Seoul', 'timezone');
[, $pdo] = Orm::parseDsn('mysql://root@localhost/orm_example?socket=/tmp/mysql.sock');
expect($pdo === 'mysql:unix_socket=/tmp/mysql.sock;dbname=orm_example;charset=utf8mb4', "mysql socket: $pdo");
[$driver, $pdo, , , $zone] = Orm::parseDsn('postgres:///orm_example?host=/tmp&timezone=%2B00:00');
expect($driver === 'postgres' && $pdo === 'pgsql:host=/tmp;port=5432;dbname=orm_example' && $zone->getName() === '+00:00', "postgres: $pdo");
[$driver, $pdo, , , , , $pragmas] = Orm::parseDsn('sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(250)&_pragma=journal_mode(WAL)');
expect($driver === 'sqlite' && $pdo === 'sqlite:/tmp/orm_example.sqlite', "sqlite: $pdo");
expect($pragmas === [['busy_timeout', '250'], ['journal_mode', 'WAL']], 'sqlite pragmas: ' . json_encode($pragmas));

foreach (['mysqlx://localhost/orm_example', 'relative/path', '', 'sqlite://relative.sqlite', 'mysql://localhost/', 'postgres://localhost/orm_example?timezone=Nowhere',
    'sqlite:///tmp/orm_example.sqlite?_txlock=immediate', 'sqlite:///tmp/orm_example.sqlite?_txlock=deferred', 'sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout'] as $dsn) {
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
