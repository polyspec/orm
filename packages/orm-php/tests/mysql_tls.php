<?php
// PHP client의 DSN parameter와 MySQL TLS 연결(docs/config.md): DSN은 scheme의 parameter만
// 쓰고, 절대 경로 `ssl-ca`와 host 이름을 둔 `ssl-mode=VERIFY_IDENTITY`가 유일한 MySQL TLS
// mode이며, 다른 parameter와 mode는 모두 CONFIG다. 연결 case는 `make test-servers`의
// ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN, ORM_TEST_MYSQL_TLS_MISMATCH_DSN이
// 필요하며, 하나라도 없으면 실패한다.
// Usage: php packages/orm-php/tests/mysql_tls.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;

// 각 case는 실패를 모아 그 case의 끝에 보고한다. parameter case는 memory 안의 parse이고, connection
// case는 TLS server에 세 번 연결한다.
$failures = [];

$refused = static function (string $dsn, string $wanted) use (&$failures): void {
    try {
        Orm::parseDsn($dsn);
        $failures[] = "accepted $dsn";
    } catch (OrmException $e) {
        if ($e->code_ !== Code::CONFIG || !str_contains($e->getMessage(), $wanted)) {
            $failures[] = "$dsn: {$e->code_} {$e->getMessage()}, expected CONFIG with $wanted";
        }
    }
};

testcase_begin('mysql_tls/parameters', TESTCASE_COMPUTE);
$refused('mysql://root@db.local/orm_example?charset=latin1', 'unknown parameter charset');
$refused('mysql://root@db.local/orm_example?sslmode=disable', 'unknown parameter sslmode');
$refused('postgres://root@db.local/orm_example?application_name=orm', 'unknown parameter application_name');
$refused('postgres://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY', 'unknown parameter ssl-mode');
$refused('sqlite:///tmp/orm-tls.sqlite?cache=shared', 'unknown parameter cache');
foreach (['VERIFY_CA', 'REQUIRED', 'PREFERRED', 'DISABLED', 'verify_identity', ''] as $mode) {
    $refused("mysql://root@db.local/orm_example?ssl-mode=$mode&ssl-ca=/tmp/ca.pem", 'ssl-mode');
}
$refused('mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY', 'ssl-ca');
$refused('mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem', 'absolute');
$refused('mysql://root@db.local/orm_example?ssl-ca=/tmp/ca.pem', 'ssl-mode');
foreach (['127.0.0.1', '[::1]'] as $host) {
    $refused("mysql://root@$host/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem", 'host name');
}
$refused('mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem', 'socket');
$parsed = Orm::parseDsn('mysql://root@db.local/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem');
if ($parsed[0] !== 'mysql' || $parsed[5] !== '/tmp/ca.pem') {
    $failures[] = 'parsed ' . json_encode($parsed);
}
foreach (['postgres://orm@127.0.0.1/orm_example?sslmode=disable&timezone=UTC', 'postgres:///orm_example?host=/tmp', 'sqlite:///tmp/orm-tls.sqlite?_pragma=busy_timeout(5000)&timezone=UTC',
    'mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=UTC'] as $dsn) {
    try {
        Orm::parseDsn($dsn);
    } catch (OrmException $e) {
        $failures[] = "refused $dsn: {$e->getMessage()}";
    }
}

testcase_end($failures === [] ? null : implode('; ', $failures));
$parameterFailures = count($failures);

testcase_begin('mysql_tls/connections', TESTCASE_DATABASE);
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
if (preg_match('/^TLSv1\.[23]$/', $version) !== 1) {
    $failures[] = 'the VERIFY_IDENTITY connection has Ssl_version ' . json_encode($version);
}
foreach (['another CA' => $dsns[1], 'a certificate of another host' => $dsns[2]] as $name => $dsn) {
    try {
        $sslVersion($dsn);
        $failures[] = "the connection with $name was accepted";
    } catch (OrmException $e) {
        if ($e->code_ !== Code::CONFIG || !str_contains($e->getMessage(), 'SSL')) {
            $failures[] = "the connection with $name failed for another cause: {$e->code_} {$e->getMessage()}";
        }
    }
}

testcase_end(count($failures) === $parameterFailures ? null : implode('; ', array_slice($failures, $parameterFailures)));
exit($failures === [] ? 0 : 1);
