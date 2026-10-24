<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\AesKeyring;
use Polyspec\Orm\AesRotationStatus;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use RuntimeException;

final class OrmExceptionNativeTest extends TestCase
{
    public function testAesKeyringIsProvidedByTheExtension(): void
    {
        $class = new ReflectionClass(AesKeyring::class);
        Assert::assertTrue($class->isInternal());
        Assert::assertSame('polyspec_orm', $class->getExtensionName());
    }

    public function testAesKeyringValidatesVersionsAndRotatesEveryNonNullColumn(): void
    {
        $ring = new AesKeyring([2 => 'new secret', 1 => 'old secret'], 2);
        Assert::assertSame(2, $ring->currentVersion);
        Assert::assertSame([1, 2], $ring->versions());
        Assert::assertSame('old secret', $ring->key(1));
        Assert::assertSame(17, AesKeyring::storedVersion('017'));

        $cipher = \Polyspec\Orm\Codec::hostEncode('plain', ['aes'], 'old secret')->bytes;
        $rotated = $ring->rotateRow(
            ['version' => '1', 'first' => $cipher, 'second' => null],
            'version',
            [['name' => 'first', 'styles' => ['aes']], ['name' => 'second', 'styles' => ['aes']]],
            2
        );
        Assert::assertSame(2, $rotated['version']);
        Assert::assertSame('plain', \Polyspec\Orm\Codec::hostDecode($rotated['first']->bytes, ['aes'], 'new secret'));
        Assert::assertNull($rotated['second']);
    }

    public function testAesKeyringRejectsInvalidConfigurationAndStoredVersions(): void
    {
        try {
            new AesKeyring([1 => ''], 1);
            Assert::fail('an empty key must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CONFIG, $error->code_);
        }

        try {
            AesKeyring::storedVersion('2147483648');
            Assert::fail('a version outside the positive 32-bit range must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CODEC_DECODE, $error->code_);
        }
    }

    public function testAesKeyringDoesNotReturnPartialRotationOnDecodeFailure(): void
    {
        $ring = new AesKeyring([1 => 'old secret', 2 => 'new secret'], 2);
        $first = \Polyspec\Orm\Codec::hostEncode('plain', ['aes'], 'old secret')->bytes;
        $row = ['version' => 1, 'first' => $first, 'second' => 'not an AES envelope'];
        try {
            $ring->rotateRow(
                $row,
                'version',
                [['name' => 'first', 'styles' => ['aes']], ['name' => 'second', 'styles' => ['aes']]],
                2
            );
            Assert::fail('an invalid second ciphertext must fail the complete row rotation');
        } catch (OrmException $error) {
            Assert::assertSame(Code::CODEC_DECODE, $error->code_);
        }
        Assert::assertSame(1, $row['version']);
        Assert::assertSame($first, $row['first']);
    }

    public function testAesRotationStatusRetainsItsDeclaredValues(): void
    {
        $status = new AesRotationStatus(3, 8, 2, [1 => 4, 2 => 2, 3 => 2]);
        Assert::assertSame([3, 8, 2, [1 => 4, 2 => 2, 3 => 2]], [
            $status->current,
            $status->total,
            $status->pending,
            $status->versions,
        ]);
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
            public function __construct() {}
        });

        Assert::assertSame(Code::CANCELED, $error->code_);
        Assert::assertSame('CANCELED: driver operation failed', $error->getMessage());
        Assert::assertSame($driverError, $error->getPrevious());
        Assert::assertNull($error->rollback);
        Assert::assertSame([], $error->cleanup);
    }
}
