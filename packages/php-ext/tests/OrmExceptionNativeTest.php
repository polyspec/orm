<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use RuntimeException;

final class OrmExceptionNativeTest extends TestCase
{
    public function testTheExceptionClassIsRegisteredByTheExtension(): void
    {
        $class = new ReflectionClass(OrmException::class);
        Assert::assertTrue($class->isInternal());
        Assert::assertSame('polyspec_orm', $class->getExtensionName());
    }

    public function testConstructionRetainsCodePreviousRollbackAndCleanup(): void
    {
        $previous = new RuntimeException('primary cause');
        $rollback = new RuntimeException('rollback cause');
        $cleanup = new RuntimeException('cleanup cause');
        $error = new OrmException(Code::DRIVER, 'operation failed', $previous, $rollback, [$cleanup]);

        Assert::assertSame('DRIVER: operation failed', $error->getMessage());
        Assert::assertSame(Code::DRIVER, $error->code_);
        Assert::assertSame($previous, $error->getPrevious());
        Assert::assertSame($rollback, $error->rollback);
        Assert::assertSame([$cleanup], $error->cleanup);
    }

    public function testRollbackAndCleanupFactoriesKeepTheirCauseObjects(): void
    {
        $cause = new RuntimeException('operation failed');
        $rollback = new RuntimeException('rollback failed');
        $rolled = OrmException::rollback($cause, $rollback);
        Assert::assertSame(Code::ROLLBACK, $rolled->code_);
        Assert::assertSame($cause, $rolled->getPrevious());
        Assert::assertSame($rollback, $rolled->rollback);
        Assert::assertSame([], $rolled->cleanup);

        $cleanup = new RuntimeException('restore failed');
        $combined = OrmException::withCleanup($rolled, $cleanup);
        Assert::assertSame(Code::ROLLBACK, $combined->code_);
        Assert::assertSame($rolled, $combined->getPrevious());
        Assert::assertSame([$cleanup], $combined->cleanup);
    }

    public function testDriverFactoryKeepsItsCodeAndOriginalThrowable(): void
    {
        $driverError = new \PDOException('driver operation failed');
        $driverError->errorInfo = ['HY000', 1205, 'lock wait timeout'];
        $error = OrmException::fromDriver($driverError, 'mysql', new class extends \PDO {
            public function __construct() {}
        });

        Assert::assertSame(Code::CANCELED, $error->code_);
        Assert::assertSame('CANCELED: driver operation failed', $error->getMessage());
        Assert::assertSame($driverError, $error->getPrevious());
        Assert::assertNull($error->rollback);
        Assert::assertSame([], $error->cleanup);
    }
}
