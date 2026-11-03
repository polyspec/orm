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
            Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1]], $config);
            self::fail('an AES row missing its selected version cell was accepted');
        } catch (OrmException $error) {
            Assert::assertSame('INTERNAL', $error->code_);
        }
    }

    // Requirements: COD-34.
    public function testSerializedPhpObjectsAreRejected(): void
    {
        try {
            Codec::decode(['serialize'], 'O:8:"stdClass":0:{}');
            self::fail('serialized PHP objects must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame('CODEC_UNSUPPORTED', $error->code_);
        }
    }

    // Requirements: COD-4, COD-34.
    public function testCodecValueEdges(): void
    {
        Assert::assertSame(
            '1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8',
            Codec::blindIndex('member@example.test', 'blind-key')
        );
        try {
            Codec::decode(['serialize'], 'O:8:"stdClass":0:{}');
            self::fail('serialized PHP objects must be rejected');
        } catch (OrmException $error) {
            Assert::assertSame('CODEC_UNSUPPORTED', $error->code_);
        }
    }

    // Requirements: COD-33, COD-35 (docs/spec).
    public function testCodecMalformedInputUsesDecodeCode(): void
    {
        $cases = [
            [['ordered_json'], '{'],
            [['yaml'], "a: 1\na: 2\n"],
        ];
        foreach ($cases as [$styles, $raw]) {
            try {
                Codec::decode($styles, $raw);
                self::fail('malformed codec input must be rejected');
            } catch (OrmException $error) {
                Assert::assertSame('CODEC_DECODE', $error->code_);
            }
        }
    }
}
