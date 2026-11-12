<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// The driver errors that OrmException::fromDriver maps. Each case builds the PDOException of the driver and needs no
// database.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/OrmExceptionLockWaitTest.php

use PDO;
use PDOException;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class OrmExceptionLockWaitTest extends TestCase
{
    // Requirements: PLN-24.
    public function testSqliteLockedIsDriverNotDeadlock(): void
    {
        foreach ([6, 262] as $number) {
            $message = 'database table is locked';
            $driverError = new PDOException($message);
            $driverError->errorInfo = ['HY000', $number, $message];
            $error = OrmException::fromDriver($driverError, 'sqlite', new PDO('sqlite::memory:'));
            self::assertSame(Code::DRIVER, $error->code_, "SQLITE_LOCKED {$number} maps to {$error->code_}");
        }
    }
}
