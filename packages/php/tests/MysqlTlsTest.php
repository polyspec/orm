<?php

// The DSN parameters of the PHP client and the MySQL TLS connection (docs/spec/config.md): the DSN uses only the
// parameters of the scheme, and `ssl-mode=VERIFY_IDENTITY` with an absolute `ssl-ca` path and a host name is the only
// MySQL TLS mode; every other parameter and mode is CONFIG. Connection cases need the ORM_TEST_MYSQL_TLS_DSN from `make
// orm-test-servers`, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN, and ORM_TEST_MYSQL_TLS_MISMATCH_DSN,
// and the test fails if any of them is missing.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/MysqlTlsTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

// Parameter cases are a parse in memory, and connection cases connect to the TLS server three times.
#[Medium]
final class MysqlTlsTest extends TestCase
{
    // Requirements: CFG-17, CFG-19, CFG-20.
    public function testParameters(): void
    {
        MysqlTlsCases::assertRefused(
            'mysql://root@db.local/orm_example?charset=latin1',
            'unknown parameter charset'
        );
        MysqlTlsCases::assertRefused(
            'mysql://root@db.local/orm_example?sslmode=disable',
            'unknown parameter sslmode'
        );
        MysqlTlsCases::assertRefused(
            'postgres://root@db.local/orm_example?application_name=orm',
            'unknown parameter application_name'
        );
        MysqlTlsCases::assertRefused(
            'postgres://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY',
            'unknown parameter ssl-mode'
        );
        MysqlTlsCases::assertRefused('sqlite:///tmp/orm-tls.sqlite?cache=shared', 'unknown parameter cache');
        foreach (['127.0.0.1', '[::1]'] as $host) {
            MysqlTlsCases::assertRefused(
                "mysql://root@$host/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem",
                'host name'
            );
        }
        MysqlTlsCases::assertRefused(
            'mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem',
            'socket'
        );
        $parsed = Orm::parseDsn(
            'mysql://root@db.local/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem'
        );
        self::assertTrue($parsed[0] === 'mysql' && $parsed[5] === '/tmp/ca.pem', 'parsed ' . json_encode($parsed));
        foreach (
            [
                'postgres://orm@127.0.0.1/orm_example?sslmode=disable&timezone=UTC',
                'postgres:///orm_example?host=/tmp',
                'sqlite:///tmp/orm-tls.sqlite?_pragma=busy_timeout(5000)&timezone=UTC',
            'mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=UTC'] as $dsn
        ) {
            try {
                Orm::parseDsn($dsn);
                $refused = null;
            } catch (OrmException $e) {
                $refused = $e->getMessage();
            }
            self::assertNull($refused, "refused $dsn: $refused");
        }
    }

    // Requirements: CFG-18.
    public function testUnsupportedTlsOptions(): void
    {
        MysqlTlsCases::assertUnsupportedOptions('mysql://root@db.local/orm_example', '/tmp/ca.pem');
        MysqlTlsCases::assertMissingCaRejected(
            'mysql://root@localhost/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=',
            'a missing TLS CA file must be CONFIG'
        );
    }

    // Requirements: CFG-16.
    public function testConnections(): void
    {
        $dsns = [];
        foreach (
            [
            'ORM_TEST_MYSQL_TLS_DSN',
            'ORM_TEST_MYSQL_TLS_OTHER_CA_DSN',
            'ORM_TEST_MYSQL_TLS_MISMATCH_DSN'
            ] as $name
        ) {
            $value = requiredDsn($name);
            if (!is_string($value) || $value === '') {
                throw new RuntimeException("$name is not set; run make orm-test-servers");
            }
            $dsns[] = $value;
        }
        $version = MysqlTlsCases::sslVersion($dsns[0]);
        self::assertMatchesRegularExpression(
            '/^TLSv1\.[23]$/',
            $version,
            'the VERIFY_IDENTITY connection has Ssl_version ' . json_encode($version)
        );
        foreach (['another CA' => $dsns[1], 'a certificate of another host' => $dsns[2]] as $name => $dsn) {
            try {
                MysqlTlsCases::sslVersion($dsn);
                self::fail("the connection with $name was accepted");
            } catch (OrmException $e) {
                self::assertTrue(
                    $e->code_ === Code::CONFIG && str_contains($e->getMessage(), 'SSL'),
                    "the connection with $name failed for another cause: {$e->code_} {$e->getMessage()}"
                );
            }
        }
    }

    /**
     * The session sql_mode that the client sets on every MySQL connection equals sql_mode.session of
     * tests/dsn/mysql-session.json, not the server default (docs/spec/config.md "Runtime connection").
     */
    // Requirements: CFG-7.
    public function testSessionSqlMode(): void
    {
        $dsn = requiredDsn('ORM_TEST_MYSQL_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_MYSQL_DSN is not set; run make orm-test-servers');
        }
        MysqlTlsCases::assertSessionSqlMode($dsn);
    }
}
