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

    // Requirements: DIA-201. A mysql error number is read by the table of its server: MySQL's 4025 is an InnoDB option
    // error and MariaDB's a failed CHECK, and MySQL's 3572, 3819, 3024 and 4031 name no MariaDB condition.
    public function testAMysqlErrorNumberIsReadByTheTableOfItsServer(): void
    {
        $cases = [
            [4025, Code::DRIVER, Code::CONSTRAINT], [3819, Code::CONSTRAINT, Code::DRIVER],
            [3572, Code::LOCK_NOT_AVAILABLE, Code::DRIVER], [3024, Code::CANCELED, Code::DRIVER],
            [4031, Code::CONNECTION_LOST, Code::DRIVER], [1969, Code::DRIVER, Code::CANCELED],
            [1062, Code::DUPLICATE_KEY, Code::DUPLICATE_KEY], [1452, Code::FOREIGN_KEY, Code::FOREIGN_KEY],
            [1213, Code::DEADLOCK, Code::DEADLOCK], [1290, Code::READ_ONLY, Code::READ_ONLY],
            [1205, Code::CANCELED, Code::CANCELED],
        ];
        foreach ($cases as [$number, $mysql, $mariadb]) {
            foreach (['mysql' => $mysql, 'mariadb' => $mariadb] as $server => $want) {
                $driverError = new PDOException('m');
                $driverError->errorInfo = ['HY000', $number, 'm'];
                $error = OrmException::fromDriver($driverError, $server, new PDO('sqlite::memory:'));
                self::assertSame($want, $error->code_, "{$server} {$number} maps to {$error->code_}");
            }
        }
    }

    // Requirements: DIA-209. MariaDB fails a NOWAIT lock that it cannot take at once with 1205: a statement of a
    // *_nowait lock that fails with 1205 on MariaDB is LOCK_NOT_AVAILABLE, and 1205 of a statement without a nowait
    // lock, or on MySQL, whose NOWAIT failure is 3572, is no lock error (it stays CANCELED by the table of its server).
    public function testMariadb1205OfANowaitLockIsLockNotAvailable(): void
    {
        $map = new \ReflectionMethod(\Polyspec\Orm\Db::class, 'nowaitLockError');
        $cases = [
            ['mariadb', 'update_nowait', 1205, Code::LOCK_NOT_AVAILABLE],
            ['mariadb', 'share_nowait', 1205, Code::LOCK_NOT_AVAILABLE],
            ['mariadb', 'update', 1205, null], ['mariadb', 'share', 1205, null], ['mariadb', '', 1205, null],
            ['mariadb', 'share_nowait', 1969, null],
            ['mysql', 'update_nowait', 1205, null], ['mysql', 'share_nowait', 1205, null],
            ['postgres', 'update_nowait', 1205, null],
        ];
        foreach ($cases as [$server, $lock, $number, $want]) {
            $driverError = new PDOException('m');
            $driverError->errorInfo = ['HY000', $number, 'm'];
            $error = $map->invoke(null, $server, $lock, $driverError);
            self::assertSame($want, $error?->code_, "{$server} {$lock} {$number}");
            if ($error !== null) {
                self::assertSame($driverError, $error->getPrevious());
            }
        }
    }
}
