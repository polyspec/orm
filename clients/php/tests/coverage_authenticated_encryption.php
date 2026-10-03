<?php
declare(strict_types=1);
// authenticated_encryption feature coverage: contracts/fixtures/authenticated_encryption.json의
// 각 case를 PHP client의 AES envelope(Codec::hostEncode, Codec::hostDecode의
// `aes` stage)과 blind index(Codec::blindIndex)로 실행한다.

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Orm\Bytes;
use Orm\Codec;

$fixture = coverageJson(dirname(__DIR__, 3) . '/contracts/fixtures/authenticated_encryption.json');

/** @return array<string, mixed> fixture에서 id와 operation이 같은 case */
function encryptionCase(array $fixture, string $id, string $operation): array
{
    $found = array_values(array_filter($fixture['cases'], static fn(array $c): bool => $c['id'] === $id));
    coverageWant(count($found) === 1, 'authenticated_encryption.json has ' . count($found) . " cases $id");
    coverageWant($found[0]['operation'] === $operation, "case $id has operation {$found[0]['operation']}, want $operation");
    return $found[0];
}

/** fixture의 envelope를 복호화하고 기대한 평문이나 오류 code와 비교한다. */
function decryptCase(array $fixture, string $id): void
{
    $case = encryptionCase($fixture, $id, 'aes_decrypt');
    $envelope = hex2bin($case['input']['envelope_hex']);
    if ($envelope === false) {
        throw new RuntimeException("case $id has an invalid envelope_hex");
    }
    if (isset($case['expected']['error'])) {
        $code = coverageCode(fn() => Codec::hostDecode($envelope, ['aes'], $case['input']['key']));
        coverageWant($code === $case['expected']['error'], "$id is $code, want {$case['expected']['error']}");
        return;
    }
    $plain = Codec::hostDecode($envelope, ['aes'], $case['input']['key']);
    coverageWant($plain === $case['expected']['plain'], "$id decrypted " . var_export($plain, true));
}

runCoverageCases($argv, [
    'aes_envelope_decrypt' => fn() => decryptCase($fixture, 'aes_envelope_decrypt'),
    'aes_round_trip' => function () use ($fixture): void {
        $case = encryptionCase($fixture, 'aes_round_trip', 'aes_encrypt_decrypt');
        $envelope = Codec::hostEncode($case['input']['plain'], ['aes'], $case['input']['key']);
        coverageWant($envelope instanceof Bytes, 'the envelope is not bytes');
        $prefix = hex2bin($case['expected']['prefix_hex']);
        coverageWant($prefix !== false && str_starts_with($envelope->bytes, $prefix), 'envelope prefix ' . bin2hex(substr($envelope->bytes, 0, 9)));
        coverageWant(strlen($envelope->bytes) === $case['expected']['envelope_bytes'], 'envelope length ' . strlen($envelope->bytes));
        $again = Codec::hostEncode($case['input']['plain'], ['aes'], $case['input']['key']);
        coverageWant($again->bytes !== $envelope->bytes, 'two encryptions share a nonce');
        $plain = Codec::hostDecode($envelope->bytes, ['aes'], $case['input']['key']);
        coverageWant($plain === $case['expected']['plain'], 'round trip ' . var_export($plain, true));
    },
    'aes_tamper_rejected' => fn() => decryptCase($fixture, 'aes_tamper_rejected'),
    'aes_wrong_key_rejected' => fn() => decryptCase($fixture, 'aes_wrong_key_rejected'),
    'blind_index_vector' => function () use ($fixture): void {
        $case = encryptionCase($fixture, 'blind_index_vector', 'blind_index');
        $index = Codec::blindIndex($case['input']['plain'], $case['input']['key']);
        coverageWant($index === $case['expected']['index'], "blind index $index");
    },
]);
