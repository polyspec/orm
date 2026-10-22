<?php

declare(strict_types=1);

// A MySQL lock wait timeout (1205, innodb_lock_wait_timeout) is the expiry of the write bound of CFG-6, so the driver
// error is CANCELED in OrmException::fromDriver, not DRIVER. The case builds the PDOException of the driver and needs
// no database.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist
// packages/php/tests/OrmExceptionLockWaitTest.php

use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

#[Small]
final class OrmExceptionLockWaitTest extends TestCase
{
    // Requirements: CFG-6.
    public function test_mysql_lock_wait_timeout_is_canceled(): void
    {
        $message = 'Lock wait timeout exceeded; try restarting transaction';
        $driverError = new PDOException($message);
        $driverError->errorInfo = ['HY000', 1205, $message];
        $error = OrmException::fromDriver($driverError, 'mysql', new PDO('sqlite::memory:'));
        self::assertSame(Code::CANCELED, $error->code_, "MySQL 1205 maps to {$error->code_}");
    }
}
