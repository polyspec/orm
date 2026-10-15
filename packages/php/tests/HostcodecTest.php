<?php
// Host-side codec stages: AES uses the authenticated v2 envelope and ip packs like INET6_ATON.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/HostcodecTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Bytes;
use Polyspec\Orm\Code;
use Polyspec\Orm\Codec;
use Polyspec\Orm\OrmException;

#[Small]
final class HostcodecTest extends TestCase
{
    /** $call이 code의 OrmException을 던지는지 확인한다. */
    private static function assertCode(string $code, callable $call, string $what): void
    {
        try {
            $call();
        } catch (OrmException $e) {
            self::assertSame($code, $e->code_, $what);
            return;
        }
        self::fail("$what: no error");
    }

    public function test_hostcodec(): void
    {
        $fixed = '4F524D2D414553320000112233445566778899AABB651DA9F08BE2FA7CD7B2DF5C04D91B32189DCD854A70762F99271A2BEBA64A248E24';
        self::assertSame('user42@example.com', Codec::hostDecode($fixed, ['aes', 'hex'], 'bench-salt'), 'shared fixed AES v2 vector');
        foreach ([['plain' => 'member@example.test', 'key' => 'key-v1'], ['plain' => '한글 텍스트', 'key' => 'key-v2']] as $v) {
            $raw = Codec::hostEncode($v['plain'], ['aes'], $v['key']);
            self::assertInstanceOf(Bytes::class, $raw);
            self::assertStringStartsWith("ORM-AES2\0", $raw->bytes, 'AES v2 envelope prefix');
            self::assertSame($v['plain'], Codec::hostDecode($raw->bytes, ['aes'], $v['key']), 'AES v2 round trip');
            $tampered = $raw->bytes;
            $tampered[strlen($tampered) - 1] = chr(ord($tampered[strlen($tampered) - 1]) ^ 1);
            self::assertCode(Code::CODEC_DECODE, static fn() => Codec::hostDecode($tampered, ['aes'], $v['key']), 'tampered AES → CODEC_DECODE');
        }
        foreach (['00', 'zz', '', 'EC026C86BF1C78E3660CCC20789EDF0D00'] as $bad) {
            self::assertCode(Code::CODEC_DECODE, static fn() => Codec::hostDecode($bad, ['aes', 'hex'], 'k'), "corrupt ciphertext '$bad' → CODEC_DECODE");
        }
        self::assertCode(Code::CODEC_DECODE, static fn() => Codec::hostDecode((string) Codec::hostEncode('value', ['aes', 'hex'], 'key'), ['aes', 'hex'], 'wrong-key'), 'wrong key → CODEC_DECODE');
        self::assertCode(Code::CONFIG, static fn() => Codec::hostEncode('x', ['aes', 'hex'], ''), 'no key → CONFIG');
        self::assertNull(Codec::hostEncode(null, ['aes', 'hex'], 'k'), 'null passes through');
        self::assertNull(Codec::hostDecode(null, ['aes', 'hex'], 'k'), 'null passes through');

        $ip = Codec::hostEncode('10.1.2.3', ['ip'], '');
        self::assertInstanceOf(Bytes::class, $ip);
        self::assertSame("\x0a\x01\x02\x03", $ip->bytes, 'ipv4 packs to 4 bytes');
        self::assertSame('10.1.2.3', Codec::hostDecode($ip->bytes, ['ip'], ''), 'ipv4 round trip');
        $ip6 = Codec::hostEncode(' 2001:db8::1 ', ['ip'], '');
        self::assertInstanceOf(Bytes::class, $ip6);
        self::assertSame(16, strlen($ip6->bytes), 'ipv6 packs to 16 bytes');
        self::assertSame('2001:db8::1', Codec::hostDecode($ip6->bytes, ['ip'], ''), 'ipv6 trimmed, round trip');
        $mapped = Codec::hostEncode('::ffff:10.1.2.3', ['ip'], '');
        self::assertInstanceOf(Bytes::class, $mapped);
        self::assertSame("\x0a\x01\x02\x03", $mapped->bytes, 'IPv4-mapped IPv6 packs to 4 bytes like INET6_ATON');
        self::assertSame('1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8', Codec::blindIndex('member@example.test', 'blind-key'), 'shared blind-index HMAC vector');
        self::assertCode(Code::CODEC_ENCODE, static fn() => Codec::hostEncode('not-an-ip', ['ip'], ''), 'bad address → CODEC_ENCODE');
        self::assertCode(Code::CODEC_DECODE, static fn() => Codec::hostDecode('abc', ['ip'], ''), '3 packed bytes → CODEC_DECODE');
        self::assertCode(Code::CODEC_UNSUPPORTED, static fn() => Codec::hostEncode('x', ['gz'], ''), 'codec style as host stage → CODEC_UNSUPPORTED');
    }

    /** @return iterable<string, array{array<string, mixed>}> tests/codec/decode-vectors.json의 vector마다 */
    public static function decodeVectors(): iterable
    {
        $vectors = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/tests/codec/decode-vectors.json'), true, 512, JSON_THROW_ON_ERROR)['vectors'];
        if ($vectors === []) {
            throw new RuntimeException('decode-vectors.json has no vectors');
        }
        foreach ($vectors as $v) {
            yield $v['name'] => [$v];
        }
    }

    // 공유 decode vector(tests/codec/decode-vectors.json): 저장 cell은 encoder가 쓰는 형태로만 decode되고 그 밖의
    // 형태는 CODEC_DECODE다. aes가 없는 host stage 목록은 key 없는 hostDecode로, 나머지는 decode로 읽는다.
    /** @param array<string, mixed> $v */
    #[DataProvider('decodeVectors')]
    public function test_decode_vector(array $v): void
    {
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
            self::assertSame($v['error'], $code, 'got ' . ($code !== '' ? $code : json_encode($got)));
        } else {
            self::assertSame('', $code, 'error');
            self::assertSame($v['value'], $got);
        }
    }
}
