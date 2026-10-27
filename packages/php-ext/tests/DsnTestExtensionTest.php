<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Tests\DsnTest;
use Polyspec\Orm\Orm;

// Requirements: CFG-11.
#[\PHPUnit\Framework\Attributes\Small]
final class DsnTestExtensionTest extends DsnTest
{
    public function testSharedDsnUrlPartsPreserveEmptyAuthorityRules(): void
    {
        [$driver, $pdo, $username, $password] = Orm::parseDsn(
            'mysql:///orm_example?socket=%2Ftmp%2Fmysql.sock'
        );
        self::assertSame('mysql', $driver);
        self::assertSame('mysql:unix_socket=/tmp/mysql.sock;dbname=orm_example;charset=utf8mb4', $pdo);
        self::assertSame(['', ''], [$username, $password]);
    }
}
