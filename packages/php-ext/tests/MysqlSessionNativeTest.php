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
    // Requirements: CFG-3.
    public function testNativeConnectionSetsDeclaredSqlMode(): void
    {
        self::assertTrue((new ReflectionMethod(Orm::class, 'connect'))->isInternal());
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
