<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Bytes;
use Polyspec\Orm\Codec;
use Polyspec\Orm\Config;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

#[Small]
final class CoverageAuthenticatedEncryptionExtensionTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        Assert::assertTrue((new ReflectionClass(Codec::class))->isInternal());
        foreach (['hostEncode', 'hostDecode', 'blindIndex'] as $method) {
            Assert::assertTrue(
                (new ReflectionMethod(Codec::class, $method))->isInternal(),
                "Codec::$method must run through the native extension"
            );
        }
    }

    // Requirements: COD-48. FCV-2: a selected row without its version cell is an input that no recipe value can hold.
    public function testReadRowWithoutVersionCellIsInternal(): void
    {
        Assert::assertTrue((new ReflectionMethod(Codec::class, 'decodeRows'))->isInternal());
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $rows = [[Codec::hostEncode('value', ['aes', 'hex'], 'old-key')]];
        try {
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1, 'user.aes_hex_email']], $config);
            self::fail('an AES row missing its selected version cell was accepted');
        } catch (OrmException $error) {
            Assert::assertSame('INTERNAL', $error->code_);
        }
    }
}
