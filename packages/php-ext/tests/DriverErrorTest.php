<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDO;
use PDOException;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Code;
use Polyspec\Orm\Db;
use Polyspec\Orm\DbState;

final class DriverErrorTest extends TestCase
{
    // Requirements: PRT-79.
    public function testNativeDbMapperKeepsTheDriverErrorAsPrevious(): void
    {
        self::assertTrue((new \ReflectionMethod(Db::class, 'driverError'))->isInternal());
        $message = 'trigger refused the write';
        $driverError = new PDOException($message);
        $driverError->errorInfo = ['HY000', 1644, $message];
        $pdo = (new \ReflectionClass(PDO::class))->newInstanceWithoutConstructor();
        $db = (new \ReflectionClass(Db::class))->newInstanceWithoutConstructor();
        $state = new DbState();
        $state->pdo = $pdo;
        (new \ReflectionProperty(Db::class, 'state'))->setValue($db, $state);
        (new \ReflectionProperty(Db::class, 'driver'))->setValue($db, 'mysql');
        $mapped = $db->driverError($driverError);

        self::assertSame(Code::DRIVER, $mapped->code_);
        self::assertSame('DRIVER: ' . $message, $mapped->getMessage());
        self::assertSame($driverError, $mapped->getPrevious());
    }
}
