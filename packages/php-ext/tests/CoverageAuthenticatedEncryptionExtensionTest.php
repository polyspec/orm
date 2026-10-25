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

    // Requirements: COD-5.
    public function testAesEnvelopeDecrypt(): void
    {
        [$input, $expected] = $this->fixtureCase('aes_envelope_decrypt', 'aes_decrypt');
        $envelope = hex2bin($input['envelope_hex']);
        Assert::assertNotFalse($envelope, 'the fixture envelope is valid hex');
        Assert::assertSame($expected['plain'], Codec::hostDecode($envelope, ['aes'], $input['key']));
    }

    // Requirements: COD-48.
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

    // Requirements: COD-49, COD-50, COD-51, COD-52, COD-53.
    public function testStoredVersionReadCodes(): void
    {
        Assert::assertTrue((new ReflectionMethod(Codec::class, 'decodeRows'))->isInternal());
        $config = new Config('', '', 2, [1 => 'old-key', 2 => 'new-key']);
        $cipher = Codec::hostEncode('value', ['aes', 'hex'], 'old-key');
        $cases = [
            ['non-integer text', 'abc', 'CODEC_DECODE'],
            ['zero', 0, 'CODEC_DECODE'],
            ['above i32', 2147483648, 'CODEC_DECODE'],
            ['undeclared integer', 9, 'CONFIG'],
            ['positive integer text', '1', ''],
        ];
        foreach ($cases as [$name, $version, $expected]) {
            $rows = [[$cipher, $version]];
            $got = '';
            try {
                Codec::decodeRows($rows, [[0, ['aes', 'hex'], [], true, 1]], $config);
            } catch (OrmException $error) {
                $got = $error->code_;
            }
            Assert::assertSame($expected, $got, "stored version $name");
        }
    }

    // Requirements: COD-5.
    public function testAesRoundTrip(): void
    {
        [$input, $expected] = $this->fixtureCase('aes_round_trip', 'aes_encrypt_decrypt');
        $envelope = Codec::hostEncode($input['plain'], ['aes'], $input['key']);
        Assert::assertInstanceOf(Bytes::class, $envelope);
        $prefix = hex2bin($expected['prefix_hex']);
        Assert::assertNotFalse($prefix, 'the fixture prefix is valid hex');
        Assert::assertTrue(str_starts_with($envelope->bytes, $prefix), 'the AES2 prefix matches');
        Assert::assertSame($expected['envelope_bytes'], strlen($envelope->bytes));
        Assert::assertNotSame(
            $envelope->bytes,
            Codec::hostEncode($input['plain'], ['aes'], $input['key'])->bytes,
            'two encryptions use different nonces'
        );
        Assert::assertSame($expected['plain'], Codec::hostDecode($envelope->bytes, ['aes'], $input['key']));
    }

    // Requirements: COD-6.
    public function testAesTamperRejected(): void
    {
        $this->assertDecryptError('aes_tamper_rejected');
    }

    // Requirements: COD-6.
    public function testAesWrongKeyRejected(): void
    {
        $this->assertDecryptError('aes_wrong_key_rejected');
    }

    // Requirements: COD-4.
    public function testBlindIndexVector(): void
    {
        [$input, $expected] = $this->fixtureCase('blind_index_vector', 'blind_index');
        Assert::assertSame($expected['index'], Codec::blindIndex($input['plain'], $input['key']));
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

    // Requirements: COD-33, COD-35 (docs/spec).
    public function testCodecMalformedInputUsesDecodeCode(): void
    {
        foreach ([
            [['ordered_json'], '{'],
            [['yaml'], "a: 1\na: 2\n"],
        ] as [$styles, $raw]) {
            try {
                Codec::decode($styles, $raw);
                self::fail('malformed codec input must be rejected');
            } catch (OrmException $error) {
                Assert::assertSame('CODEC_DECODE', $error->code_);
            }
        }
    }

    /** @return array{array<string, mixed>, array<string, mixed>} */
    private function fixtureCase(string $id, string $operation): array
    {
        $path = dirname(__DIR__, 3) . '/contracts/fixtures/authenticated_encryption.json';
        $fixture = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        $matches = array_values(array_filter(
            $fixture['cases'],
            static fn(array $case): bool => $case['id'] === $id
        ));
        Assert::assertCount(1, $matches, "the shared fixture contains case $id once");
        Assert::assertSame($operation, $matches[0]['operation'], "case $id has operation $operation");
        return [$matches[0]['input'], $matches[0]['expected']];
    }

    private function assertDecryptError(string $id): void
    {
        [$input, $expected] = $this->fixtureCase($id, 'aes_decrypt');
        $envelope = hex2bin($input['envelope_hex']);
        Assert::assertNotFalse($envelope, "case $id has a valid hex envelope");
        try {
            Codec::hostDecode($envelope, ['aes'], $input['key']);
            self::fail("case $id decrypted");
        } catch (OrmException $error) {
            Assert::assertSame($expected['error'], $error->code_, "error code of $id");
        }
    }
}
