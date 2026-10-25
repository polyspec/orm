<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use ReflectionMethod;
use RuntimeException;

final class MysqlSessionNativeTest extends TestCase
{
    // Requirements: CFG-7.
    public function testNativeConnectionSetsDeclaredSqlMode(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $dsn = requiredDsn('ORM_TEST_MYSQL_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_MYSQL_DSN is not set; run make orm-test-servers');
        }
        \Polyspec\Orm\Tests\MysqlTlsCases::assertSessionSqlMode($dsn);
    }

    // Requirements: CFG-7.
    public function testNativePostgresSessionSettingsAreStartupParameters(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $dsn = requiredDsn('ORM_TEST_POSTGRES_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_POSTGRES_DSN is not set; run make orm-test-servers');
        }
        $db = Orm::connect($dsn, new Config(statementTimeoutMs: 237));
        try {
            $rows = $db->fetch(
                'utility',
                [],
                null,
                "SELECT name, setting, source FROM pg_settings WHERE name IN ('TimeZone', 'statement_timeout')"
            );
        } finally {
            $db->close();
        }
        $settings = [];
        foreach ($rows as [$name, $setting, $source]) {
            $settings[$name] = [$setting, $source];
        }
        self::assertSame('UTC', $settings['TimeZone'][0] ?? null, 'TimeZone');
        self::assertSame('237', $settings['statement_timeout'][0] ?? null, 'statement_timeout');
        if (getenv('ORM_TEST_POSTGRES_DSN') === getenv('ORM_TEST_POSTGRES_SERVER_DSN')) {
            self::assertSame('client', $settings['TimeZone'][1] ?? null, 'TimeZone startup source');
            self::assertSame('client', $settings['statement_timeout'][1] ?? null, 'timeout startup source');
        }
    }
}
