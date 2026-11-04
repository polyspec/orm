<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\Config;
use Polyspec\Orm\Schema;
use Polyspec\Orm\Orm;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use RuntimeException;

final class OrmExceptionNativeTest extends TestCase
{
    public function testOrmConnectionFactoryIsProvidedByTheExtension(): void
    {
        $class = new ReflectionClass(Orm::class);
        Assert::assertTrue($class->isInternal());
        Assert::assertSame('polyspec_orm', $class->getExtensionName());
    }

    public function testOrmConnectionFactoryRejectsAConfigThatIsNotConfigBeforeOpeningSqlite(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-connect-config-type-');
        Assert::assertIsString($path);
        unlink($path);
        try {
            try {
                Orm::connect('sqlite:///' . $path, new \stdClass());
                Assert::fail('connect accepted an object that is not a Config');
            } catch (\TypeError $error) {
                Assert::assertStringContainsString('Config', $error->getMessage());
            }
            Assert::assertFileDoesNotExist($path);
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testNativeMysqlTlsOptionsRequireAReadableCaFile(): void
    {
        Assert::assertSame([], Orm::mysqlTlsOptions(null));
        $path = tempnam(sys_get_temp_dir(), 'orm-native-ca-');
        Assert::assertNotFalse($path);
        try {
            $options = Orm::mysqlTlsOptions($path);
            Assert::assertSame($path, $options[\Pdo\Mysql::ATTR_SSL_CA]);
            Assert::assertTrue($options[\Pdo\Mysql::ATTR_SSL_VERIFY_SERVER_CERT]);
        } finally {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    public function testConnectSchemaVerifiesBeforeConnecting(): void
    {
        $schema = new Schema('', 'not a hash');
        try {
            Orm::connectSchema('not a DSN', $schema, new Config());
            Assert::fail('a schema with an invalid hash must fail before connecting');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
        }
    }

    public function testConnectSchemaChecksSchemaTypeBeforeConfigTypeAndDsn(): void
    {
        try {
            Orm::connectSchema('not a DSN', new \stdClass(), new \stdClass());
            Assert::fail('connectSchema accepted objects that are not Schema and Config');
        } catch (\TypeError $error) {
            Assert::assertStringContainsString('Schema', $error->getMessage());
        }
    }

    public function testNativeSqliteConnectionFailurePreservesThePdoCause(): void
    {
        $path = sys_get_temp_dir() . '/orm-native-connect-missing-' . bin2hex(random_bytes(6)) . '/db.sqlite';
        try {
            Orm::connect('sqlite://' . $path, new Config());
            Assert::fail('a database under a nonexistent directory must fail to connect');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
            Assert::assertInstanceOf(\PDOException::class, $error->getPrevious());
        }
    }

    public function testAesKeyringIsProvidedByTheExtension(): void
    {
        $class = new ReflectionClass(AesKeyring::class);
        Assert::assertTrue($class->isInternal());
        Assert::assertSame('polyspec_orm', $class->getExtensionName());
    }

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
            public function __construct()
            {
            }
        });

        Assert::assertSame(Code::CANCELED, $error->code_);
        Assert::assertSame('CANCELED: driver operation failed', $error->getMessage());
        Assert::assertSame($driverError, $error->getPrevious());
        Assert::assertNull($error->rollback);
        Assert::assertSame([], $error->cleanup);
    }

    // fromDriver reads the declared errorInfo of a PDOException; repeated driver errors must leave
    // the Zend heap intact.
    public function testDriverFactoryLeavesTheHeapIntactAcrossRepeatedDriverErrors(): void
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $kept = [];
        for ($i = 0; $i < 500; $i++) {
            try {
                $pdo->exec("SELECT * FROM missing_$i");
                self::fail("the query of missing_$i did not fail");
            } catch (\PDOException $driverError) {
                $error = OrmException::fromDriver($driverError, 'sqlite', $pdo);
                Assert::assertSame(Code::DRIVER, $error->code_);
                Assert::assertSame($driverError, $error->getPrevious());
                $kept[] = [$error, str_repeat('x', $i % 64)];
            }
        }
        Assert::assertCount(500, $kept);
        Assert::assertSame(['HY000', 1, 'no such table: missing_499'], $kept[499][0]->getPrevious()->errorInfo);
    }

    // Requirements: PLN-24.
    public function testSqliteLockedIsDriverNotDeadlock(): void
    {
        foreach ([6, 262] as $number) {
            $message = 'database table is locked';
            $driverError = new \PDOException($message);
            $driverError->errorInfo = ['HY000', $number, $message];
            $error = OrmException::fromDriver($driverError, 'sqlite', new \PDO('sqlite::memory:'));
            Assert::assertSame(Code::DRIVER, $error->code_, "SQLITE_LOCKED {$number} maps to {$error->code_}");
        }
    }
}
