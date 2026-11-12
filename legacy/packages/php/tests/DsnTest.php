<?php

// DSN parsing: the scheme selects the driver; the timezone parameter accepts only UTC.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/DsnTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
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
        self::assertSame(
            ['postgres', 'pgsql:host=/tmp;port=5432;dbname=orm_example;sslmode=disable'],
            [$driver, $pdo],
            'postgres'
        );
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
            ['postgres', 'pgsql:host=pool.example;port=5432;dbname=app;sslmode=disable', 'user', 'secret', [], null],
            Orm::parseDsn('postgres://user:secret@pool.example/app?host=pool.example&sslmode=disable'),
            'the host parameter equal to the host of the URL'
        );
        self::assertSame(
            ['sqlite', 'sqlite:/tmp/app db.sqlite', null, null, [['journal_mode', 'WAL']], null],
            Orm::parseDsn('sqlite:///tmp/app%20db.sqlite?_pragma=journal_mode(WAL)'),
            'a decoded sqlite path'
        );
        self::assertSame(
            ['sqlite', 'sqlite:/tmp/app.sqlite', null, null, [], null],
            Orm::parseDsn('SQLite:///tmp/app.sqlite'),
            'the scheme in another case'
        );
        self::assertSame(
            ['sqlite', 'sqlite:/tmp/app.sqlite', null, null, [['busy_timeout', '200'], ['journal_mode', 'WAL']], null],
            Orm::parseDsn('sqlite:///tmp/app.sqlite?_pragma=busy_timeout(200)&_pragma=journal_mode(WAL)'),
            'the _pragma parameters in order'
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
        $accepts = 'CONFIG: mysql DSN has the unknown parameter "extra"; it accepts timezone, socket, ssl-mode, ssl-ca';
        foreach (
            [
                [
                    'mysql://root@db.local/?socket=/tmp/s.sock',
                    'CONFIG: mysql DSN socket needs the host localhost, which names the local server',
                ],
                [
                    'postgres://h1/?host=h2',
                    'CONFIG: postgres DSN names two hosts, "h1" in the URL and "h2" in the host parameter',
                ],
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
        $form = 'CONFIG: markdown DSN is markdown://127.0.0.1:<port>/<corpus>?token=<token>';
        foreach (
            [
                [
                    'markdown://127.0.0.1:49152/corpus?extra=%ZZ',
                    'CONFIG: markdown DSN has the unknown parameter "extra"; it accepts token, timezone, _pragma',
                ],
                ['markdown:///x?token=a', "$form; host \"\": a flowmark server listens on 127.0.0.1 only"],
                ['markdown:///x?token=a#y', 'CONFIG: markdown DSN has a fragment, which no connection reads'],
                [
                    'markdown://127%2E0.0.1:1/x?token=a',
                    'CONFIG: markdown DSN host "127%2E0.0.1" holds a percent escape, which no host name needs',
                ],
                [
                    'markdown://127.0.0.1:port/x?token=a',
                    'CONFIG: dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://',
                ],
                ['markdown://127.0.0.1:1/x?token=a&token=b', 'CONFIG: markdown DSN repeats the parameter "token"'],
                ['markdown://127.0.0.1:1/x', 'CONFIG: markdown DSN is missing the parameter "token"'],
                ['markdown://127.0.0.1:1/x?token=a&', 'CONFIG: markdown DSN has the unknown parameter ""; '
                    . 'it accepts token, timezone, _pragma'],
                ['markdown://127.0.0.1:1/x?token=a&_pragma=a;b', 'CONFIG: markdown DSN _pragma "a;b" is invalid'],
                [
                    'markdown://127.0.0.1:1/x?token=a&timezone=%2B09:00',
                    'CONFIG: dsn timezone "+09:00": every connection reads and writes datetime values in UTC',
                ],
            ] as [$dsn, $message]
        ) {
            try {
                Orm::parseMarkdownDsn($dsn);
                self::fail("$dsn was accepted");
            } catch (OrmException $error) {
                self::assertSame($message, $error->getMessage(), $dsn);
            }
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
        $accepted = ['timezone', 'host', 'sslmode'];
        [$parts, $query] = DsnUrl::parse('POSTGRES:///orm_example?host=%2Ftmp&timezone=UTC', 'postgres', $accepted);
        self::assertSame('', $parts['host'], 'an empty authority is the host "", never localhost');
        self::assertSame(['host' => '/tmp', 'timezone' => 'UTC'], $query);
        self::assertSame(
            ['_pragma' => ['a(1)', 'b c(2)']],
            DsnUrl::query('sqlite', '_pragma=a(1)&_pragma=b+c%282%29', ['timezone', '_pragma', '_txlock']),
            'the _pragma values in written order, form-decoded'
        );
        self::assertSame([], DsnUrl::query('sqlite', '', ['timezone']), 'an empty query has no pair');
        try {
            DsnUrl::query('sqlite', '_pragma=a(1)&&_pragma=b(2)', ['timezone', '_pragma', '_txlock']);
            self::fail('an empty pair was accepted');
        } catch (OrmException $error) {
            self::assertSame(
                'CONFIG: sqlite DSN has the unknown parameter ""; it accepts timezone, _pragma, _txlock',
                $error->getMessage()
            );
        }
    }
}
