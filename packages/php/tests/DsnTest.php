<?php
// DSN parsing: the scheme selects the driver; the timezone parameter accepts only UTC.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DsnTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

#[Small]
final class DsnTest extends TestCase
{
    public function test_parse(): void
    {
        [$driver, $pdo, $user, $password] = Orm::parseDsn('mysql://orm:p%40ss@db.local:3307/orm_example?timezone=UTC');
        self::assertSame('mysql', $driver);
        self::assertSame('mysql:host=db.local;port=3307;dbname=orm_example;charset=utf8mb4', $pdo, 'mysql pdo dsn');
        self::assertSame(['orm', 'p@ss'], [$user, $password], 'mysql credentials');
        [, $pdo] = Orm::parseDsn('mysql://root@localhost/orm_example?socket=/tmp/mysql.sock');
        self::assertSame('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_example;charset=utf8mb4', $pdo, 'mysql socket');
        [$driver, $pdo] = Orm::parseDsn('postgres:///orm_example?host=/tmp&timezone=%2B00:00');
        self::assertSame(['postgres', 'pgsql:host=/tmp;port=5432;dbname=orm_example'], [$driver, $pdo], 'postgres');
        [$driver, $pdo, , , $pragmas] = Orm::parseDsn('sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(250)&_pragma=journal_mode(WAL)');
        self::assertSame(['sqlite', 'sqlite:/tmp/orm_example.sqlite'], [$driver, $pdo], 'sqlite');
        self::assertSame([['busy_timeout', '250'], ['journal_mode', 'WAL']], $pragmas, 'sqlite pragmas');
    }

    /** @return iterable<string, array{string}> */
    public static function invalidDsns(): iterable
    {
        foreach (['mysqlx://localhost/orm_example', 'relative/path', '', 'sqlite://relative.sqlite', 'mysql://localhost/', 'postgres://localhost/orm_example?timezone=Nowhere', 'mysql://localhost/orm_example?timezone=%2B09:00', 'sqlite:///tmp/orm_example.sqlite?timezone=Asia%2FSeoul',
            'sqlite:///tmp/orm_example.sqlite?_txlock=immediate', 'sqlite:///tmp/orm_example.sqlite?_txlock=deferred', 'sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout'] as $dsn) {
            yield ($dsn === '' ? 'empty' : $dsn) => [$dsn];
        }
    }

    #[DataProvider('invalidDsns')]
    public function test_parse_rejects(string $dsn): void
    {
        try {
            Orm::parseDsn($dsn);
            self::fail("invalid DSN accepted: $dsn");
        } catch (OrmException $e) {
            self::assertSame(Code::CONFIG, $e->code_, "wrong error for $dsn");
        }
    }

    // query 가 붙은 SQLite DSN 은 path 만으로 file 을 만든다. query 를 file 이름에 둔
    // opener 는 `named.sqlite?_pragma=…` 같은 file 을 만든다(docs/dialects.md "Probe environment").
    public function test_sqlite_file_name(): void
    {
        $directory = sys_get_temp_dir() . '/orm-php-sqlite-name-' . getmypid();
        self::assertFalse(file_exists($directory), "temporary directory $directory exists");
        self::assertTrue(mkdir($directory), "temporary directory $directory");
        $db = Orm::connect("sqlite://$directory/named.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00", new Config());
        $db = null;
        $names = array_values(array_diff(scandir($directory), ['.', '..']));
        foreach ($names as $name) {
            self::assertContains($name, ['named.sqlite', 'named.sqlite-journal', 'named.sqlite-shm', 'named.sqlite-wal'], 'files ' . json_encode($names) . ": $name is not named by the path");
            self::assertTrue(unlink("$directory/$name"), "remove $name");
        }
        self::assertTrue(rmdir($directory), "remove $directory");
        self::assertContains('named.sqlite', $names, 'files ' . json_encode($names) . ': named.sqlite is missing');
    }

    /** @return iterable<string, array{array<string, mixed>}> tests/dsn/sqlite-paths.json의 case마다 */
    public static function sqlitePaths(): iterable
    {
        $vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dsn/sqlite-paths.json'), true, 512, JSON_THROW_ON_ERROR);
        if ($vectors['version'] !== 1 || $vectors['cases'] === []) {
            throw new RuntimeException('tests/dsn/sqlite-paths.json has no cases');
        }
        foreach ($vectors['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // tests/dsn/sqlite-paths.json: DSN path 는 percent-decode 한 file 을 열고, 잘못된 path 는
    // CONFIG 다(docs/config.md "Runtime connection").
    /** @param array<string, mixed> $case */
    #[DataProvider('sqlitePaths')]
    public function test_sqlite_path(array $case): void
    {
        $directory = sys_get_temp_dir() . "/orm-php-sqlite-path-" . getmypid() . "-{$case['id']}";
        self::assertFalse(file_exists($directory), "temporary directory $directory exists");
        self::assertTrue(mkdir($directory), "temporary directory $directory");
        $code = null;
        try {
            $db = Orm::connect("sqlite://$directory/{$case['path']}", new Config());
            $db = null;
        } catch (OrmException $e) {
            $code = $e->code_;
        }
        $names = array_values(array_diff(scandir($directory), ['.', '..']));
        foreach ($names as $name) {
            self::assertTrue(unlink("$directory/$name"), "remove $name");
        }
        self::assertTrue(rmdir($directory), "remove $directory");
        $files = json_encode($names, JSON_UNESCAPED_UNICODE);
        if (isset($case['error'])) {
            self::assertSame([$case['error'], []], [$code, $names], "code and files; want {$case['error']} and no file");
            return;
        }
        self::assertNull($code, "code $code");
        foreach ($names as $name) {
            self::assertContains($name, [$case['file'], "{$case['file']}-journal", "{$case['file']}-shm", "{$case['file']}-wal"], "files $files: $name is not {$case['file']}");
        }
        self::assertContains($case['file'], $names, "files $files: {$case['file']} is missing");
    }
}
