<?php
// PHP client의 DSN parameter와 MySQL TLS 연결(docs/config.md): DSN은 scheme의 parameter만
// 쓰고, 절대 경로 `ssl-ca`와 host 이름을 둔 `ssl-mode=VERIFY_IDENTITY`가 유일한 MySQL TLS
// mode이며, 다른 parameter와 mode는 모두 CONFIG다. 연결 case는 `make test-servers`의
// ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN, ORM_TEST_MYSQL_TLS_MISMATCH_DSN이
// 필요하며, 하나라도 없으면 실패한다.
// Usage: packages/php/vendor/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/MysqlTlsTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

// parameter case는 memory 안의 parse이고, connection case는 TLS server에 세 번 연결한다.
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
            self::assertTrue($e->code_ === Code::CONFIG && str_contains($e->getMessage(), $wanted), "$dsn: {$e->code_} {$e->getMessage()}, expected CONFIG with $wanted");
        }
    }

    public function test_parameters(): void
    {
        self::refused('mysql://root@db.local/orm_example?charset=latin1', 'unknown parameter charset');
        self::refused('mysql://root@db.local/orm_example?sslmode=disable', 'unknown parameter sslmode');
        self::refused('postgres://root@db.local/orm_example?application_name=orm', 'unknown parameter application_name');
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
        self::refused('mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem', 'socket');
        $parsed = Orm::parseDsn('mysql://root@db.local/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem');
        self::assertTrue($parsed[0] === 'mysql' && $parsed[5] === '/tmp/ca.pem', 'parsed ' . json_encode($parsed));
        foreach (['postgres://orm@127.0.0.1/orm_example?sslmode=disable&timezone=UTC', 'postgres:///orm_example?host=/tmp', 'sqlite:///tmp/orm-tls.sqlite?_pragma=busy_timeout(5000)&timezone=UTC',
            'mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=UTC'] as $dsn) {
            try {
                Orm::parseDsn($dsn);
                $refused = null;
            } catch (OrmException $e) {
                $refused = $e->getMessage();
            }
            self::assertNull($refused, "refused $dsn: $refused");
        }
    }

    public function test_connections(): void
    {
        $config = new Config();
        $sslVersion = static function (string $dsn) use ($config): string {
            $db = Orm::connect($dsn, $config);
            try {
                return (string) ($db->pdo()->query("SHOW SESSION STATUS LIKE 'Ssl_version'")->fetch(\PDO::FETCH_NUM)[1] ?? '');
            } finally {
                $db->close();
            }
        };
        $dsns = [];
        foreach (['ORM_TEST_MYSQL_TLS_DSN', 'ORM_TEST_MYSQL_TLS_OTHER_CA_DSN', 'ORM_TEST_MYSQL_TLS_MISMATCH_DSN'] as $name) {
            $value = getenv($name);
            if (!is_string($value) || $value === '') {
                throw new RuntimeException("$name is not set; run make test-servers");
            }
            $dsns[] = $value;
        }
        $version = $sslVersion($dsns[0]);
        self::assertMatchesRegularExpression('/^TLSv1\.[23]$/', $version, 'the VERIFY_IDENTITY connection has Ssl_version ' . json_encode($version));
        foreach (['another CA' => $dsns[1], 'a certificate of another host' => $dsns[2]] as $name => $dsn) {
            try {
                $sslVersion($dsn);
                self::fail("the connection with $name was accepted");
            } catch (OrmException $e) {
                self::assertTrue($e->code_ === Code::CONFIG && str_contains($e->getMessage(), 'SSL'), "the connection with $name failed for another cause: {$e->code_} {$e->getMessage()}");
            }
        }
    }
}
