<?php

// DSN parsing: the scheme selects the driver; the timezone parameter accepts only UTC.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DsnTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\DsnUrl;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

#[Small]
class DsnTest extends TestCase
{
    public static function assertValueFunctionIr(): void
    {
        $params = ['preceding'];
        $ir = Orm::secondsAgo(30)->ir(static function (mixed $value) use (&$params): int {
            $params[] = $value;
            return count($params) - 1;
        });
        self::assertSame('{"name":"seconds_ago","ps":[1]}', json_encode($ir, JSON_THROW_ON_ERROR));
        self::assertSame(
            '{"name":"seconds_ago","ps":[0]}',
            json_encode(Orm::secondsAgo(30)->ir(static fn(): int => 0), JSON_THROW_ON_ERROR)
        );
        self::assertSame('{"name":"now"}', json_encode(Orm::now()->ir(static fn(): int => 0), JSON_THROW_ON_ERROR));
    }

    public function testParse(): void
    {
        [$driver, $pdo, $user, $password] = Orm::parseDsn('mysql://orm:p%40ss@db.local:3307/orm_example?timezone=UTC');
        self::assertSame('mysql', $driver);
        self::assertSame('mysql:host=db.local;port=3307;dbname=orm_example;charset=utf8mb4', $pdo, 'mysql pdo dsn');
        self::assertSame(['orm', 'p@ss'], [$user, $password], 'mysql credentials');
        [, $pdo] = Orm::parseDsn('mysql://root@localhost/orm_example?socket=/tmp/mysql.sock');
        self::assertSame('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_example;charset=utf8mb4', $pdo, 'mysql socket');
        [$driver, $pdo] = Orm::parseDsn('postgres:///orm_example?host=/tmp&timezone=%2B00:00');
        self::assertSame(['postgres', 'pgsql:host=/tmp;port=5432;dbname=orm_example'], [$driver, $pdo], 'postgres');
        [$driver, $pdo, , , $pragmas] = Orm::parseDsn(
            'sqlite:///tmp/orm_example.sqlite?_pragma=busy_timeout(250)&_pragma=journal_mode(WAL)'
        );
        self::assertSame(['sqlite', 'sqlite:/tmp/orm_example.sqlite'], [$driver, $pdo], 'sqlite');
        self::assertSame([['busy_timeout', '250'], ['journal_mode', 'WAL']], $pragmas, 'sqlite pragmas');
        self::assertSame(
            ['mysql', 'mysql:host=db.example;port=3307;dbname=app;charset=utf8mb4', 'user', 'p@ss', [], null],
            Orm::parseDsn('mysql://user:p%40ss@db.example:3307/app?timezone=UTC'),
            'the whole mysql tuple'
        );
        self::assertSame(
            ['postgres', 'pgsql:host=pool.example;port=5432;dbname=app;sslmode=require', 'user', 'secret', [], null],
            Orm::parseDsn('postgres://user:secret@db.example/app?host=pool.example&sslmode=require'),
            'the host parameter over the host of the URL'
        );
        self::assertSame(
            ['sqlite', 'sqlite:/tmp/app db.sqlite', null, null, [['journal_mode', 'WAL']], null],
            Orm::parseDsn('sqlite:///tmp/app%20db.sqlite?_pragma=journal_mode(WAL)'),
            'a decoded sqlite path'
        );
        self::assertSame(
            ['sqlite', 'sqlite:/tmp/app.sqlite', null, null, [['busy_timeout', '200'], ['journal_mode', 'WAL']], null],
            Orm::parseDsn('sqlite:///tmp/app.sqlite?&_pragma=busy_timeout(200)&&_pragma=journal_mode(WAL)&'),
            'empty query parts'
        );
        self::assertSame(
            ['127.0.0.1:49152', 'corpus', 'a token', []],
            Orm::parseMarkdownDsn('markdown://127.0.0.1:49152/corpus?token=a+token'),
            'a decoded markdown token'
        );
        self::assertSame(
            ['127.0.0.1:49152', 'corpus', 't', [['busy_timeout', '200'], ['journal_mode', 'WAL']]],
            Orm::parseMarkdownDsn(
                'markdown://127.0.0.1:49152/corpus?token=t&_pragma=busy_timeout(200)&_pragma=journal_mode(WAL)'
            ),
            'the _pragma settings of a markdown DSN, in order'
        );
        // The text of a refusal in the two PHP modes; the recipes dsn_reject and dsn_reject_parameters hold the parts
        // that every runtime that refuses it shares.
        $accepts = 'CONFIG: mysql DSN has the unknown parameter extra; it accepts timezone, socket, ssl-mode, ssl-ca';
        foreach (
            [
                ['mysql://db.example/app?extra=value', $accepts],
                ['mysql://db.example/app?extra=%ZZ', $accepts],
                [
                    'mysql://db.example/app?ssl-mode=disabled&ssl-ca=%2Ftmp%2Fca.pem',
                    'CONFIG: mysql DSN ssl-mode "disabled" is not supported; '
                    . 'the TLS mode is ssl-mode=VERIFY_IDENTITY with ssl-ca',
                ],
            ] as [$dsn, $message]
        ) {
            try {
                Orm::parseDsn($dsn);
                self::fail("$dsn was accepted");
            } catch (OrmException $error) {
                self::assertSame($message, $error->getMessage());
            }
        }
        try {
            Orm::parseMarkdownDsn('markdown://127.0.0.1:49152/corpus?extra=%ZZ');
            self::fail('an unknown markdown parameter was accepted');
        } catch (OrmException $error) {
            self::assertSame(
                'CONFIG: markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>; it does not accept extra',
                $error->getMessage()
            );
        }
        // The fields of a function value in the two PHP modes; the plans of these functions are in the planner vectors.
        foreach (
            [
                ['now', [], Orm::now(), false],
                ['today', [], Orm::today(), false],
                ['seconds_ago', [3], Orm::secondsAgo(3), false],
                ['minutes_ago', [3], Orm::minutesAgo(3), false],
                ['hours_ago', [3], Orm::hoursAgo(3), false],
                ['days_ago', [3], Orm::daysAgo(3), false],
                ['months_ago', [3], Orm::monthsAgo(3), false],
                ['seconds_later', [3], Orm::secondsLater(3), false],
                ['minutes_later', [3], Orm::minutesLater(3), false],
                ['hours_later', [3], Orm::hoursLater(3), false],
                ['days_later', [3], Orm::daysLater(3), false],
                ['months_later', [3], Orm::monthsLater(3), false],
                ['day_of_week', [], Orm::dayOfWeek(), true],
                ['year', [], Orm::year(), true],
                ['month', [], Orm::month(), true],
                ['date', [], Orm::date(), true],
            ] as [$name, $args, $function, $column]
        ) {
            self::assertSame([$name, $args, $column], [$function->name, $function->args, $function->column]);
        }
    }

    public function testSharedDsnUrlPartsPreserveEmptyAuthorityRules(): void
    {
        [$parts, $query] = DsnUrl::parse('postgres:///orm_example?host=%2Ftmp&timezone=UTC', 'postgres');
        self::assertSame('localhost', $parts['host']);
        self::assertSame(['host' => '/tmp', 'timezone' => 'UTC'], $query);
    }

    /** @return iterable<string, array{array<string, mixed>}> for each case in tests/dsn/sqlite-paths.json */
    public static function sqlitePaths(): iterable
    {
        $vectors = json_decode(
            file_get_contents(dirname(__DIR__, 3) . '/tests/dsn/sqlite-paths.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        if ($vectors['version'] !== 1 || $vectors['cases'] === []) {
            throw new RuntimeException('tests/dsn/sqlite-paths.json has no cases');
        }
        foreach ($vectors['cases'] as $case) {
            yield $case['id'] => [$case];
        }
    }

    // tests/dsn/sqlite-paths.json: a DSN path opens the percent-decoded file, and a wrong path is
    // CONFIG (docs/spec/config.md "Runtime connection").
    /** @param array<string, mixed> $case */
    #[DataProvider('sqlitePaths')]
    public function testSqlitePath(array $case): void
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
            self::assertSame(
                [$case['error'], []],
                [$code, $names],
                "code and files; want {$case['error']} and no file"
            );
            return;
        }
        self::assertNull($code, "code $code");
        foreach ($names as $name) {
            self::assertContains(
                $name,
                [$case['file'], "{$case['file']}-journal", "{$case['file']}-shm", "{$case['file']}-wal"],
                "files $files: $name is not {$case['file']}"
            );
        }
        self::assertContains($case['file'], $names, "files $files: {$case['file']} is missing");
    }
}
