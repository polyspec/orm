<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// authenticated_encryption feature coverage: each case in contracts/fixtures/authenticated_encryption.json
// runs with the PHP client's AES envelope (Codec::hostEncode, the Codec::hostDecode
// `aes` stage) and the blind index (Codec::blindIndex).


use RuntimeException;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Codec;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/** @return array<string, mixed> the case in the fixture with the same id and operation */
function encryptionCase(array $fixture, string $id, string $operation): array
{
    $found = array_values(array_filter($fixture['cases'], static fn(array $c): bool => $c['id'] === $id));
    Assert::assertTrue(count($found) === 1, 'authenticated_encryption.json has ' . count($found) . " cases $id");
    Assert::assertTrue(
        $found[0]['operation'] === $operation,
        "case $id has operation {$found[0]['operation']}, want $operation"
    );
    return $found[0];
}

/** Decrypts the fixture's envelope and compares it with the expected plaintext or error code. */
function decryptCase(array $fixture, string $id): void
{
    $case = encryptionCase($fixture, $id, 'aes_decrypt');
    $envelope = hex2bin($case['input']['envelope_hex']);
    if ($envelope === false) {
        throw new RuntimeException("case $id has an invalid envelope_hex");
    }
    if (isset($case['expected']['error'])) {
        $code = coverageCode(fn() => Codec::hostDecode($envelope, ['aes'], $case['input']['key']));
        Assert::assertTrue($code === $case['expected']['error'], "$id is $code, want {$case['expected']['error']}");
        return;
    }
    $plain = Codec::hostDecode($envelope, ['aes'], $case['input']['key']);
    Assert::assertTrue($plain === $case['expected']['plain'], "$id decrypted " . var_export($plain, true));
}

#[Small]
final class CoverageAuthenticatedEncryptionTest extends TestCase
{
    // With the extension loaded (php-extension, S10) the codec is the extension's class, not the PHP client's.
    public static function setUpBeforeClass(): void
    {
        if (extension_loaded('polyspec_orm')) {
            Assert::assertTrue(
                (new \ReflectionClass(Codec::class))->isInternal(),
                'the Codec of the loaded extension is the extension class'
            );
        }
    }

    public function testAesEnvelopeDecrypt(): void
    {
        $fixture = coverageJson(dirname(__DIR__, 3) . '/contracts/fixtures/authenticated_encryption.json');
        decryptCase($fixture, 'aes_envelope_decrypt');
    }

    public function testAesRoundTrip(): void
    {
        $fixture = coverageJson(dirname(__DIR__, 3) . '/contracts/fixtures/authenticated_encryption.json');
        $case = encryptionCase($fixture, 'aes_round_trip', 'aes_encrypt_decrypt');
        $envelope = Codec::hostEncode($case['input']['plain'], ['aes'], $case['input']['key']);
        Assert::assertTrue($envelope instanceof Bytes, 'the envelope is not bytes');
        $prefix = hex2bin($case['expected']['prefix_hex']);
        Assert::assertTrue(
            $prefix !== false && str_starts_with($envelope->bytes, $prefix),
            'envelope prefix ' . bin2hex(substr($envelope->bytes, 0, 9))
        );
        Assert::assertTrue(
            strlen($envelope->bytes) === $case['expected']['envelope_bytes'],
            'envelope length ' . strlen($envelope->bytes)
        );
        $again = Codec::hostEncode($case['input']['plain'], ['aes'], $case['input']['key']);
        Assert::assertTrue($again->bytes !== $envelope->bytes, 'two encryptions share a nonce');
        $plain = Codec::hostDecode($envelope->bytes, ['aes'], $case['input']['key']);
        Assert::assertTrue($plain === $case['expected']['plain'], 'round trip ' . var_export($plain, true));
    }

    public function testAesTamperRejected(): void
    {
        $fixture = coverageJson(dirname(__DIR__, 3) . '/contracts/fixtures/authenticated_encryption.json');
        decryptCase($fixture, 'aes_tamper_rejected');
    }

    public function testAesWrongKeyRejected(): void
    {
        $fixture = coverageJson(dirname(__DIR__, 3) . '/contracts/fixtures/authenticated_encryption.json');
        decryptCase($fixture, 'aes_wrong_key_rejected');
    }

    public function testBlindIndexVector(): void
    {
        $fixture = coverageJson(dirname(__DIR__, 3) . '/contracts/fixtures/authenticated_encryption.json');
        $case = encryptionCase($fixture, 'blind_index_vector', 'blind_index');
        $index = Codec::blindIndex($case['input']['plain'], $case['input']['key']);
        Assert::assertTrue($index === $case['expected']['index'], "blind index $index");
    }
}
