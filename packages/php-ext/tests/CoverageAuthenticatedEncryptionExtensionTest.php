<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Bytes;
use Polyspec\Orm\Codec;
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

    public function testAesEnvelopeDecrypt(): void
    {
        [$input, $expected] = $this->fixtureCase('aes_envelope_decrypt', 'aes_decrypt');
        $envelope = hex2bin($input['envelope_hex']);
        Assert::assertNotFalse($envelope, 'the fixture envelope is valid hex');
        Assert::assertSame($expected['plain'], Codec::hostDecode($envelope, ['aes'], $input['key']));
    }

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

    public function testAesTamperRejected(): void
    {
        $this->assertDecryptError('aes_tamper_rejected');
    }

    public function testAesWrongKeyRejected(): void
    {
        $this->assertDecryptError('aes_wrong_key_rejected');
    }

    public function testBlindIndexVector(): void
    {
        [$input, $expected] = $this->fixtureCase('blind_index_vector', 'blind_index');
        Assert::assertSame($expected['index'], Codec::blindIndex($input['plain'], $input['key']));
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
