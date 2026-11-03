<?php

// The session sql_mode of the PHP client. The MySQL TLS connection and its refusals are cases of
// contracts/fixtures/dsn_connection and contracts/fixtures/dsn_reject.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/MysqlTlsTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;
use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

// Parameter cases are a parse in memory, and connection cases connect to the TLS server three times.
#[Medium]
final class MysqlTlsTest extends TestCase
{
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
