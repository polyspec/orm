<?php

// The MySQL TLS connection of the PHP client (docs/spec/config.md). The refused parameters and modes are cases of
// contracts/fixtures/dsn_reject. Connection cases need the ORM_TEST_MYSQL_TLS_DSN from `make
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
    // Requirements: CFG-3, CFG-7.
    public function testSessionSqlMode(): void
    {
        $dsn = requiredDsn('ORM_TEST_MYSQL_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_MYSQL_DSN is not set; run make orm-test-servers');
        }
        MysqlTlsCases::assertSessionSqlMode($dsn);
    }
}
