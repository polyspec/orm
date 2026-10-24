<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Orm;
use ReflectionMethod;
use RuntimeException;

final class MysqlSessionNativeTest extends TestCase
{
    // Requirements: CFG-3.
    public function testNativeConnectionSetsDeclaredSqlMode(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
        $dsn = requiredDsn('ORM_TEST_MYSQL_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_TEST_MYSQL_DSN is not set; run make orm-test-servers');
        }
        \Polyspec\Orm\Tests\MysqlTlsCases::assertSessionSqlMode($dsn);
    }
}
