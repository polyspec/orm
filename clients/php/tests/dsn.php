<?php
// DSN parsing: the scheme selects the driver; the timezone parameter accepts only UTC.
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

[$driver, $pdo, $user, $password] = Orm::parseDsn('mysql://orm:p%40ss@db.local:3307/orm_example?timezone=UTC');
expect($driver === 'mysql' && $pdo === 'mysql:host=db.local;port=3307;dbname=orm_example;charset=utf8mb4', "mysql pdo dsn: $pdo");
expect($user === 'orm' && $password === 'p@ss', 'mysql credentials');
[, $pdo] = Orm::parseDsn('mysql://root@localhost/orm_example?socket=/tmp/mysql.sock');
expect($pdo === 'mysql:unix_socket=/tmp/mysql.sock;dbname=orm_example;charset=utf8mb4', "mysql socket: $pdo");
[$driver, $pdo] = Orm::parseDsn('postgres:///orm_example?host=/tmp&timezone=%2B00:00');
expect($driver === 'postgres' && $pdo === 'pgsql:host=/tmp;port=5432;dbname=orm_example', "postgres: $pdo");
[$driver, $pdo, , , $pragmas] = Orm::parseDsn('sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(250)&_pragma=journal_mode(WAL)');
expect($driver === 'sqlite' && $pdo === 'sqlite:/tmp/orm_example.sqlite', "sqlite: $pdo");
expect($pragmas === [['busy_timeout', '250'], ['journal_mode', 'WAL']], 'sqlite pragmas: ' . json_encode($pragmas));

foreach (['mysqlx://localhost/orm_example', 'relative/path', '', 'sqlite://relative.sqlite', 'mysql://localhost/', 'postgres://localhost/orm_example?timezone=Nowhere', 'mysql://localhost/orm_example?timezone=%2B09:00', 'sqlite:///tmp/orm_example.sqlite?timezone=Asia%2FSeoul',
    'sqlite:///tmp/orm_example.sqlite?_txlock=immediate', 'sqlite:///tmp/orm_example.sqlite?_txlock=deferred', 'sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout'] as $dsn) {
    try {
        Orm::parseDsn($dsn);
        throw new RuntimeException("invalid DSN accepted: $dsn");
    } catch (OrmException $e) {
        expect($e->code_ === Code::CONFIG, "wrong error for $dsn");
    }
}
echo "php DSN parsing passed\n";
