<?php

// The DSN parameters of the PHP client and the MySQL TLS connection (docs/spec/config.md): the DSN uses only the
// parameters of the scheme, and `ssl-mode=VERIFY_IDENTITY` with an absolute `ssl-ca` path and a host name is the only
// MySQL TLS mode; every other parameter and mode is CONFIG. Connection cases need the ORM_TEST_MYSQL_TLS_DSN from `make
// orm-test-servers`, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN, and ORM_TEST_MYSQL_TLS_MISMATCH_DSN,
// and the test fails if any of them is missing.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/MysqlTlsTest.php
declare(strict_types=1);


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
    /** parseDsn refuses $dsn with CONFIG and a message that contains $wanted. */
    private static function refused(string $dsn, string $wanted): void
    {
        try {
            Orm::parseDsn($dsn);
            self::fail("accepted $dsn");
        } catch (OrmException $e) {
            self::assertTrue(
                $e->code_ === Code::CONFIG && str_contains($e->getMessage(), $wanted),
                "$dsn: {$e->code_} {$e->getMessage()}, expected CONFIG with $wanted"
            );
        }
    }

    // Requirements: CFG-17, CFG-18, CFG-19.
    public function testParameters(): void
    {
        self::refused('mysql://root@db.local/orm_example?charset=latin1', 'unknown parameter charset');
        self::refused('mysql://root@db.local/orm_example?sslmode=disable', 'unknown parameter sslmode');
        self::refused(
            'postgres://root@db.local/orm_example?application_name=orm',
            'unknown parameter application_name'
        );
        self::refused('postgres://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY', 'unknown parameter ssl-mode');
        self::refused('sqlite:///tmp/orm-tls.sqlite?cache=shared', 'unknown parameter cache');
        foreach (['VERIFY_CA', 'REQUIRED', 'PREFERRED', 'DISABLED', 'verify_identity', ''] as $mode) {
            self::refused("mysql://root@db.local/orm_example?ssl-mode=$mode&ssl-ca=/tmp/ca.pem", 'ssl-mode');
        }
        self::refused('mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY', 'ssl-ca');
        self::refused('mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem', 'absolute');
        self::refused('mysql://root@db.local/orm_example?ssl-ca=/tmp/ca.pem', 'ssl-mode');
        foreach (['127.0.0.1', '[::1]'] as $host) {
            self::refused("mysql://root@$host/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem", 'host name');
        }
        self::refused(
            'mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem',
            'socket'
        );
        $parsed = Orm::parseDsn(
            'mysql://root@db.local/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem'
        );
        self::assertTrue($parsed[0] === 'mysql' && $parsed[5] === '/tmp/ca.pem', 'parsed ' . json_encode($parsed));
        foreach (
            ['postgres://orm@127.0.0.1/orm_example?sslmode=disable&timezone=UTC', 'postgres:///orm_example?host=/tmp', 'sqlite:///tmp/orm-tls.sqlite?_pragma=busy_timeout(5000)&timezone=UTC',
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

    // Requirements: CFG-16.
    public function testConnections(): void
    {
        $config = new Config();
        $sslVersion = static function (string $dsn) use ($config): string {
            $db = Orm::connect($dsn, $config);
            try {
                return (string) (
                    $db->pdo()->query("SHOW SESSION STATUS LIKE 'Ssl_version'")->fetch(\PDO::FETCH_NUM)[1] ?? ''
                );
            } finally {
                $db->close();
            }
        };
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
        $version = $sslVersion($dsns[0]);
        self::assertMatchesRegularExpression(
            '/^TLSv1\.[23]$/',
            $version,
            'the VERIFY_IDENTITY connection has Ssl_version ' . json_encode($version)
        );
        foreach (['another CA' => $dsns[1], 'a certificate of another host' => $dsns[2]] as $name => $dsn) {
            try {
                $sslVersion($dsn);
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
        $vector = json_decode(
            (string) file_get_contents(__DIR__ . '/../../../tests/dsn/mysql-session.json'),
            true,
            512,
            JSON_THROW_ON_ERROR
        );
        $db = Orm::connect($dsn, new Config());
        try {
            $mode = (string) $db->pdo()->query('SELECT @@SESSION.sql_mode')->fetchColumn();
        } finally {
            $db->close();
        }
        self::assertSame($vector['sql_mode']['session'], $mode, '@@SESSION.sql_mode');
    }
}
