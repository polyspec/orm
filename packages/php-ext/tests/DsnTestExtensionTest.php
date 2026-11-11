<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DsnTest;
use Polyspec\Orm\Orm;

// Requirements: CFG-11, CFG-26.
#[\PHPUnit\Framework\Attributes\Small]
final class DsnTestExtensionTest extends DsnTest
{
    public function testSharedDsnUrlPartsPreserveEmptyAuthorityRules(): void
    {
        [$driver, $pdo, $username, $password] = Orm::parseDsn(
            'mysql://localhost/orm_example?socket=%2Ftmp%2Fmysql.sock'
        );
        self::assertSame('mysql', $driver);
        self::assertSame('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_example;charset=utf8mb4', $pdo);
        self::assertSame(['', ''], [$username, $password]);
        // An empty authority names no host, and a socket DSN names the host localhost (CFG-10).
        try {
            Orm::parseDsn('mysql:///orm_example?socket=%2Ftmp%2Fmysql.sock');
            self::fail('a socket DSN without a host was accepted');
        } catch (\Polyspec\Orm\OrmException $error) {
            self::assertSame('CONFIG: mysql DSN must include host and database', $error->getMessage());
        }
    }
}
