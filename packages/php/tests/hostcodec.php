<?php
// Host-side codec stages: AES uses the authenticated v2 envelope and ip packs like INET6_ATON.
// Usage: php packages/php/tests/hostcodec.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Bytes;
use Polyspec\Orm\Code;
use Polyspec\Orm\Codec;
use Polyspec\Orm\OrmException;

$fail = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }

testcase_begin('hostcodec', TESTCASE_COMPUTE);
$n = 0;
$fixed = '4F524D2D414553320000112233445566778899AABB651DA9F08BE2FA7CD7B2DF5C04D91B32189DCD854A70762F99271A2BEBA64A248E24';
check(Codec::hostDecode($fixed, ['aes', 'hex'], 'bench-salt') === 'user42@example.com', 'shared fixed AES v2 vector');
foreach ([['plain' => 'member@example.test', 'key' => 'key-v1'], ['plain' => '한글 텍스트', 'key' => 'key-v2']] as $v) {
    $raw = Codec::hostEncode($v['plain'], ['aes'], $v['key']);
    check($raw instanceof Bytes && str_starts_with($raw->bytes, "ORM-AES2\0"), 'AES v2 envelope prefix');
    check(Codec::hostDecode($raw->bytes, ['aes'], $v['key']) === $v['plain'], 'AES v2 round trip');
    $tampered = $raw->bytes; $tampered[strlen($tampered) - 1] = chr(ord($tampered[strlen($tampered) - 1]) ^ 1);
    try { Codec::hostDecode($tampered, ['aes'], $v['key']); check(false, 'tampered AES must fail'); }
    catch (OrmException $e) { check($e->code_ === Code::CODEC_DECODE, 'tampered AES → CODEC_DECODE'); }
    $n++;
}

foreach (['00', 'zz', '', 'EC026C86BF1C78E3660CCC20789EDF0D00'] as $bad) {
    try {
        Codec::hostDecode($bad, ['aes', 'hex'], 'k');
        check(false, "corrupt ciphertext '$bad' must fail");
    } catch (OrmException $e) {
        check($e->code_ === Code::CODEC_DECODE, "corrupt ciphertext '$bad' → CODEC_DECODE");
    }
}
try {
    Codec::hostDecode((string) Codec::hostEncode('value', ['aes', 'hex'], 'key'), ['aes', 'hex'], 'wrong-key');
    check(false, 'a wrong key must fail (padding check)');
} catch (OrmException $e) {
    check($e->code_ === Code::CODEC_DECODE, 'wrong key → CODEC_DECODE');
}
try {
    Codec::hostEncode('x', ['aes', 'hex'], '');
    check(false, 'an empty key must fail');
} catch (OrmException $e) {
    check($e->code_ === Code::CONFIG, 'no key → CONFIG');
}
check(Codec::hostEncode(null, ['aes', 'hex'], 'k') === null && Codec::hostDecode(null, ['aes', 'hex'], 'k') === null, 'null passes through');

$ip = Codec::hostEncode('10.1.2.3', ['ip'], '');
check($ip instanceof Bytes && $ip->bytes === "\x0a\x01\x02\x03", 'ipv4 packs to 4 bytes');
check(Codec::hostDecode($ip->bytes, ['ip'], '') === '10.1.2.3', 'ipv4 round trip');
$ip6 = Codec::hostEncode(' 2001:db8::1 ', ['ip'], '');
check($ip6 instanceof Bytes && strlen($ip6->bytes) === 16 && Codec::hostDecode($ip6->bytes, ['ip'], '') === '2001:db8::1', 'ipv6 packs to 16 bytes, trimmed, round trip');
$mapped = Codec::hostEncode('::ffff:10.1.2.3', ['ip'], '');
check($mapped instanceof Bytes && $mapped->bytes === "\x0a\x01\x02\x03", 'IPv4-mapped IPv6 packs to 4 bytes like INET6_ATON');
check(Codec::blindIndex('member@example.test', 'blind-key') === '1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8', 'shared blind-index HMAC vector');
try {
    Codec::hostEncode('not-an-ip', ['ip'], '');
    check(false, 'a bad address must fail');
} catch (OrmException $e) {
    check($e->code_ === Code::CODEC_ENCODE, 'bad address → CODEC_ENCODE');
}
try {
    Codec::hostDecode('abc', ['ip'], '');
    check(false, '3 packed bytes must fail');
} catch (OrmException $e) {
    check($e->code_ === Code::CODEC_DECODE, '3 packed bytes → CODEC_DECODE');
}
try {
    Codec::hostEncode('x', ['gz'], '');
    check(false, 'a codec style is not a host stage');
} catch (OrmException $e) {
    check($e->code_ === Code::CODEC_UNSUPPORTED, 'codec style as host stage → CODEC_UNSUPPORTED');
}

// 공유 decode vector(tests/codec/decode-vectors.json): 저장 cell은 encoder가 쓰는 형태로만 decode되고 그 밖의
// 형태는 CODEC_DECODE다. aes가 없는 host stage 목록은 key 없는 hostDecode로, 나머지는 decode로 읽는다.
$decodeVectors = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/tests/codec/decode-vectors.json'), true, 512, JSON_THROW_ON_ERROR)['vectors'];
check($decodeVectors !== [], 'decode-vectors.json has vectors');
// purrphp/yaml 1.0.0 CoreSchema matches true, null and .inf without regard to case; the YAML 1.2.2 core
// schema (10.3.2) takes only true|True|TRUE, null|Null|NULL and .inf|.Inf|.INF, so these keys are
// strings. Each is printed as skipped until the purrphp release of T142-1-1 is pinned.
$phpDecodeExclusions = [
    'yaml-key-plain-mixed-case-true' => 'purrphp/yaml 1.0.0 CoreSchema reads tRUE as true, not the string (T142-1-1)',
    'yaml-key-plain-mixed-case-null' => 'purrphp/yaml 1.0.0 CoreSchema reads nULL as null, not the string (T142-1-1)',
    'yaml-key-plain-mixed-case-infinity' => 'purrphp/yaml 1.0.0 CoreSchema reads .InF as infinity, not the string (T142-1-1)',
];
foreach ($decodeVectors as $v) {
    if (isset($phpDecodeExclusions[$v['name']])) {
        fwrite(STDERR, "skipped {$v['name']}: {$phpDecodeExclusions[$v['name']]}\n");
        continue;
    }
    $raw = array_key_exists('stored', $v) ? $v['stored'] : (string) hex2bin($v['stored_hex']);
    $host = array_diff($v['styles'], ['hex', 'ip']) === [];
    $got = null;
    $code = '';
    try {
        $got = $host ? Codec::hostDecode($raw, $v['styles'], '') : Codec::decode($v['styles'], $raw)->payload();
    } catch (OrmException $e) {
        $code = $e->code_;
    }
    if (array_key_exists('error', $v)) {
        check($code === $v['error'], "{$v['name']}: got " . ($code !== '' ? $code : json_encode($got)) . ", want {$v['error']}");
    } else {
        check($code === '' && $got === $v['value'], "{$v['name']}: got " . ($code !== '' ? $code : json_encode($got)) . ', want ' . json_encode($v['value']));
    }
}

if ($fail > 0) {
    throw new RuntimeException("$fail check(s) failed; each FAIL line above names one");
}
testcase_step("$n authenticated AES vectors, IP packing and " . count($decodeVectors) . ' decode vectors checked');
testcase_end();
