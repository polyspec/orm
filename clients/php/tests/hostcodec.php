<?php
// Host-side codec stages (S6): the PHP AES must produce exactly MySQL's HEX(AES_ENCRYPT(v, key)) bytes —
// every entry of tests/codec/aes-vectors.json (recorded from the local MySQL) byte for byte, both ways —
// and ip must pack like INET6_ATON. Needs no database and no ormd.
// Usage: php clients/php/tests/hostcodec.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Bytes;
use Orm\Code;
use Orm\Codec;
use Orm\OrmException;

$fail = 0;
function check(bool $ok, string $what): void { global $fail; if (!$ok) { $fail++; fwrite(STDERR, "FAIL: $what\n"); } }

$file = dirname(__DIR__, 3) . '/tests/codec/aes-vectors.json';
$f = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
check($f['mode'] === 'aes-128-ecb', "vectors were generated with {$f['mode']}");
$n = 0;
foreach ($f['vectors'] as $v) {
    $enc = Codec::hostEncode($v['plain'], ['aes', 'hex'], $v['key']);
    check($enc === $v['hex'], "encode key {$v['key']} plain {$v['plain']}: got " . var_export($enc, true) . " want {$v['hex']}");
    $dec = Codec::hostDecode($v['hex'], ['aes', 'hex'], $v['key']);
    check($dec === $v['plain'], "decode key {$v['key']}: got " . var_export($dec, true));
    // the same bytes without hex are a Bytes value (a bytea/BLOB bind), lower-case hex decodes too
    $raw = Codec::hostEncode($v['plain'], ['aes'], $v['key']);
    check($raw instanceof Bytes && strtoupper(bin2hex($raw->bytes)) === $v['hex'], "raw aes bytes for key {$v['key']}");
    check(Codec::hostDecode(strtolower($v['hex']), ['aes', 'hex'], $v['key']) === $v['plain'], 'lower-case hex decodes');
    $n++;
}
check($n === 8, "8 vectors checked ($n)");

foreach (['00', 'zz', '', 'EC026C86BF1C78E3660CCC20789EDF0D00'] as $bad) {
    try {
        Codec::hostDecode($bad, ['aes', 'hex'], 'k');
        check(false, "corrupt ciphertext '$bad' must fail");
    } catch (OrmException $e) {
        check($e->code_ === Code::CODEC_DECODE, "corrupt ciphertext '$bad' → CODEC_DECODE");
    }
}
try {
    Codec::hostDecode('EC026C86BF1C78E3660CCC20789EDF0D', ['aes', 'hex'], 'wrong-key');
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
check(Codec::foldKey('0123456789abcdef') === '0123456789abcdef' && Codec::foldKey('k') === "k\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0", 'key fold: 16 bytes stay, shorter keys are zero-padded');
check(Codec::foldKey('a-much-longer-key-than-sixteen-bytes') === (Codec::foldKey('a-much-longer-ke') ^ 'y-than-sixteen-b' ^ "ytes\0\0\0\0\0\0\0\0\0\0\0\0"), 'key fold: longer keys XOR block-wise');

$ip = Codec::hostEncode('10.1.2.3', ['ip'], '');
check($ip instanceof Bytes && $ip->bytes === "\x0a\x01\x02\x03", 'ipv4 packs to 4 bytes');
check(Codec::hostDecode($ip->bytes, ['ip'], '') === '10.1.2.3', 'ipv4 round trip');
$ip6 = Codec::hostEncode(' 2001:db8::1 ', ['ip'], '');
check($ip6 instanceof Bytes && strlen($ip6->bytes) === 16 && Codec::hostDecode($ip6->bytes, ['ip'], '') === '2001:db8::1', 'ipv6 packs to 16 bytes, trimmed, round trip');
$mapped = Codec::hostEncode('::ffff:10.1.2.3', ['ip'], '');
check($mapped instanceof Bytes && $mapped->bytes === "\x0a\x01\x02\x03", 'IPv4-mapped IPv6 packs to 4 bytes like INET6_ATON');
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

if ($fail === 0) {
    echo "ok — $n aes vectors byte-identical to MySQL, ip packing checked\n";
    exit(0);
}
exit(1);
