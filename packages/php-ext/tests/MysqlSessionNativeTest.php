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
    // Requirements: CFG-3, CFG-7.
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
        \Polyspec\Orm\Tests\PostgresSessionSettings::assertStartupParameters($dsn);
    }
}
