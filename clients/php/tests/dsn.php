<?php
// DSN parsing: the scheme selects the driver; the timezone parameter accepts only UTC.
// Usage: php clients/php/tests/dsn.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Code;
use Orm\Config;
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
// query 가 붙은 SQLite DSN 은 path 만으로 file 을 만든다. query 를 file 이름에 둔
// opener 는 `named.sqlite?_pragma=…` 같은 file 을 만든다(docs/dialects.md "Probe environment").
$directory = sys_get_temp_dir() . '/orm-php-sqlite-name-' . getmypid();
expect(!file_exists($directory) && mkdir($directory), "temporary directory $directory");
$db = Orm::connect("sqlite://$directory/named.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00", new Config());
$db = null;
$names = array_values(array_diff(scandir($directory), ['.', '..']));
foreach ($names as $name) {
    expect(in_array($name, ['named.sqlite', 'named.sqlite-journal', 'named.sqlite-shm', 'named.sqlite-wal'], true), 'files ' . json_encode($names) . ": $name is not named by the path");
    expect(unlink("$directory/$name"), "remove $name");
}
expect(rmdir($directory), "remove $directory");
expect(in_array('named.sqlite', $names, true), 'files ' . json_encode($names) . ': named.sqlite is missing');

// tests/dsn/sqlite-paths.json: DSN path 는 percent-decode 한 file 을 열고, 잘못된 path 는
// CONFIG 다(docs/config.md "Runtime connection").
$vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dsn/sqlite-paths.json'), true, 512, JSON_THROW_ON_ERROR);
expect($vectors['version'] === 1 && $vectors['cases'] !== [], 'tests/dsn/sqlite-paths.json has no cases');
foreach ($vectors['cases'] as $case) {
    $started = hrtime(true);
    echo "RUN dsn/sqlite-path/{$case['id']}\n";
    $directory = sys_get_temp_dir() . "/orm-php-sqlite-path-" . getmypid() . "-{$case['id']}";
    expect(!file_exists($directory) && mkdir($directory), "temporary directory $directory");
    $code = null;
    try {
        $db = Orm::connect("sqlite://$directory/{$case['path']}", new Config());
        $db = null;
    } catch (OrmException $e) {
        $code = $e->code_;
    }
    $names = array_values(array_diff(scandir($directory), ['.', '..']));
    foreach ($names as $name) {
        expect(unlink("$directory/$name"), "remove $name");
    }
    expect(rmdir($directory), "remove $directory");
    if (isset($case['error'])) {
        expect($code === $case['error'] && $names === [], "dsn/sqlite-path/{$case['id']}: code " . json_encode($code) . ', files ' . json_encode($names, JSON_UNESCAPED_UNICODE) . "; want {$case['error']} and no file");
    } else {
        expect($code === null, "dsn/sqlite-path/{$case['id']}: code $code");
        foreach ($names as $name) {
            expect(in_array($name, [$case['file'], "{$case['file']}-journal", "{$case['file']}-shm", "{$case['file']}-wal"], true), "dsn/sqlite-path/{$case['id']}: files " . json_encode($names, JSON_UNESCAPED_UNICODE) . ": $name is not {$case['file']}");
        }
        expect(in_array($case['file'], $names, true), "dsn/sqlite-path/{$case['id']}: files " . json_encode($names, JSON_UNESCAPED_UNICODE) . ": {$case['file']} is missing");
    }
    echo "PASS dsn/sqlite-path/{$case['id']} elapsedMs=" . ((hrtime(true) - $started) / 1e6) . "\n";
}

echo "php DSN parsing passed\n";
