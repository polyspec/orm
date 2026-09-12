<?php
declare(strict_types=1);

namespace Orm;

use Symfony\Component\Yaml\Yaml;

/**
 * Column-style codecs (docs/codec.md). Styles are in write order; decode applies them in reverse.
 * The host stages (aes/hex/ip) are the ones a dialect leaves to the executor (docs/dialects.md):
 * MySQL runs them in SQL, PostgreSQL asks for aes/hex, SQLite for all three. They come first on
 * write (before the codec stages already applied by the builder) and last on read.
 */
final class Codec
{
    /** @param list<string> $styles */
    public static function decode(array $styles, mixed $raw): mixed
    {
        if (is_resource($raw)) {
            $raw = stream_get_contents($raw); // pdo_pgsql hands bytea columns over as streams
        }
        if ($raw === null || $raw === '') {
            return null;
        }
        if (!is_string($raw)) {
            throw new OrmException(Code::CODEC_DECODE, 'cell is not a string');
        }
        $v = $raw;
        for ($i = count($styles) - 1; $i >= 0; $i--) {
            switch ($styles[$i]) {
                case 'gz':
                    $v = @gzuncompress($v);
                    if ($v === false) {
                        throw new OrmException(Code::CODEC_DECODE, 'gz: bad zlib stream');
                    }
                    break;
                case 'base64':
                    $v = base64_decode(trim($v), true);
                    if ($v === false) {
                        throw new OrmException(Code::CODEC_DECODE, 'base64: bad input');
                    }
                    break;
                case 'serialize':
                    if (preg_match('/^(O|C|r|R):/', $v) === 1 || str_contains($v, ';O:') || str_contains($v, ';C:')) {
                        throw new OrmException(Code::CODEC_UNSUPPORTED, 'serialize: objects and references are not supported');
                    }
                    $v = @unserialize($v, ['allowed_classes' => false]);
                    if ($v === false && $raw !== serialize(false)) {
                        throw new OrmException(Code::CODEC_DECODE, 'serialize: bad format');
                    }
                    $v = self::normalize($v);
                    break;
                case 'yaml':
                    try {
                        $v = Yaml::parse($v, Yaml::PARSE_EXCEPTION_ON_INVALID_TYPE | Yaml::PARSE_EXCEPTION_ON_ALIAS);
                        $v = self::normalize($v);
                        self::validateYamlValue($v);
                    } catch (\Throwable $e) {
                        throw new OrmException(Code::CODEC_DECODE, 'yaml: ' . $e->getMessage());
                    }
                    break;
                case 'curlfile':
                    $v = self::restoreUploadFiles($v);
                    break;
                case 'json':
                case 'jsons':
                    try {
                        $v = json_decode($v, true, 512, JSON_THROW_ON_ERROR);
                    } catch (\JsonException $e) {
                        throw new OrmException(Code::CODEC_DECODE, 'json: ' . $e->getMessage());
                    }
                    break;
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "style {$styles[$i]}");
            }
        }
        return $v;
    }

    /**
     * Encodes a value with the column's styles in write order. A gz result is binary and comes back as Bytes
     * so the executor binds it as a blob (bytea on PostgreSQL rejects it as text); everything else is text.
     * @param list<string> $styles
     */
    public static function encode(array $styles, mixed $v): string|Bytes|null
    {
        if ($v === null) {
            return null;
        }
        $cur = null;
        $value = $v;
        foreach ($styles as $i => $st) {
            switch ($st) {
                case 'curlfile':
                    if ($i !== 0) {
                        throw new OrmException(Code::CODEC_UNSUPPORTED, 'curlfile must be the first style');
                    }
                    $value = self::prepareUploadFiles($value);
                    break;
                case 'serialize':
                    $cur = serialize($value);
                    break;
                case 'yaml':
                    if ($i !== 0) {
                        throw new OrmException(Code::CODEC_UNSUPPORTED, 'yaml must be the first style');
                    }
                    try {
                        self::validateYamlValue($value);
                        $cur = Yaml::dump($value, 20, 2, Yaml::DUMP_EXCEPTION_ON_INVALID_TYPE | Yaml::DUMP_EMPTY_ARRAY_AS_SEQUENCE | Yaml::DUMP_NUMERIC_KEY_AS_STRING);
                    } catch (\Throwable $e) {
                        throw new OrmException(Code::CODEC_ENCODE, 'yaml: ' . $e->getMessage());
                    }
                    break;
                case 'json':
                case 'jsons':
                    $cur = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
                    break;
                case 'base64':
                    $cur = base64_encode($cur);
                    break;
                case 'gz':
                    $cur = gzcompress($cur, 9);
                    break;
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "style $st");
            }
        }
        return $styles[count($styles) - 1] === 'gz' ? new Bytes($cur) : $cur;
    }

    private static function prepareUploadFiles(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (($value['$type'] ?? null) === 'upload_file') {
            if (count($value) !== 4 || !is_string($value['path'] ?? null) || $value['path'] === ''
                || !is_string($value['mime'] ?? null) || !is_string($value['name'] ?? null) || $value['name'] === '') {
                throw new OrmException(Code::CODEC_ENCODE, 'curlfile: upload_file requires non-empty path and name plus string mime');
            }
            return ['is_curl_file' => true, 'mime' => $value['mime'], 'name' => $value['name'], 'path' => $value['path']];
        }
        foreach ($value as $key => $item) {
            if (is_array($item)) {
                $value[$key] = self::prepareUploadFiles($item);
            }
        }
        return $value;
    }

    private static function restoreUploadFiles(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (($value['is_curl_file'] ?? null) === true) {
            if (count($value) !== 4 || !is_string($value['path'] ?? null) || $value['path'] === ''
                || !is_string($value['mime'] ?? null) || !is_string($value['name'] ?? null) || $value['name'] === '') {
                throw new OrmException(Code::CODEC_DECODE, 'curlfile: invalid stored upload file');
            }
            return ['$type' => 'upload_file', 'path' => $value['path'], 'mime' => $value['mime'], 'name' => $value['name']];
        }
        foreach ($value as $key => $item) {
            if (is_array($item)) {
                $value[$key] = self::restoreUploadFiles($item);
            }
        }
        return $value;
    }

    private static function validateYamlValue(mixed $value): void
    {
        if (is_float($value) && !is_finite($value)) {
            throw new \InvalidArgumentException('non-finite numbers are not supported');
        }
        if (!is_array($value)) {
            if ($value !== null && !is_bool($value) && !is_int($value) && !is_float($value) && !is_string($value)) {
                throw new \InvalidArgumentException('value type is not supported');
            }
            return;
        }
        foreach ($value as $item) {
            self::validateYamlValue($item);
        }
    }

    // ---- host stages: aes (MySQL AES_ENCRYPT bytes), hex (upper-case), ip (INET6_ATON packing) ----

    /** Whether a style is a host stage rather than a codec stage. */
    public static function isHostStyle(string $style): bool
    {
        return $style === 'aes' || $style === 'hex' || $style === 'ip';
    }

    /**
     * MySQL's key derivation for aes-128-ecb: the key bytes XOR-folded into one 16-byte block.
     * The same fold makes the host AES byte-identical to `AES_ENCRYPT(v, key)` (tests/codec/aes-vectors.json).
     */
    public static function foldKey(string $key): string
    {
        $k = str_repeat("\0", 16);
        for ($i = 0, $n = strlen($key); $i < $n; $i++) {
            $k[$i % 16] = chr(ord($k[$i % 16]) ^ ord($key[$i]));
        }
        return $k;
    }

    /**
     * Applies the host stages of a bind slot (`bind_slots[].host_styles`, write order) to a value.
     * Returns a string when the last stage is hex (text column), otherwise Bytes (a binary column:
     * raw AES output or a packed address) so the executor binds it as a blob.
     * @param list<string> $styles
     */
    public static function hostEncode(mixed $v, array $styles, string $aesKey): string|Bytes|null
    {
        if ($v === null) {
            return null;
        }
        $cur = $v instanceof Bytes ? $v->bytes : (is_string($v) ? $v : (string) $v);
        foreach ($styles as $st) {
            switch ($st) {
                case 'aes':
                    if ($aesKey === '') {
                        throw new OrmException(Code::CONFIG, 'secret aes not configured');
                    }
                    $cur = openssl_encrypt($cur, 'aes-128-ecb', self::foldKey($aesKey), OPENSSL_RAW_DATA); // PKCS7 padding is openssl's default
                    if ($cur === false) {
                        throw new OrmException(Code::CODEC_ENCODE, 'aes: ' . (string) openssl_error_string());
                    }
                    break;
                case 'hex':
                    $cur = strtoupper(bin2hex($cur));
                    break;
                case 'ip':
                    $cur = self::packIp($cur);
                    break;
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "host style $st");
            }
        }
        return $styles[count($styles) - 1] === 'hex' ? $cur : new Bytes($cur);
    }

    /** Undoes hostEncode on a read cell (styles in write order, applied in reverse). @param list<string> $styles */
    public static function hostDecode(mixed $raw, array $styles, string $aesKey): ?string
    {
        if (is_resource($raw)) {
            $raw = stream_get_contents($raw);
        }
        if ($raw === null) {
            return null;
        }
        if (!is_string($raw)) {
            throw new OrmException(Code::CODEC_DECODE, 'cell is not bytes');
        }
        $cur = $raw;
        for ($i = count($styles) - 1; $i >= 0; $i--) {
            switch ($styles[$i]) {
                case 'hex':
                    $cur = @hex2bin(trim($cur));
                    if ($cur === false) {
                        throw new OrmException(Code::CODEC_DECODE, 'hex: odd length or non-hex input');
                    }
                    break;
                case 'aes':
                    if ($aesKey === '') {
                        throw new OrmException(Code::CONFIG, 'secret aes not configured');
                    }
                    if ($cur === '' || strlen($cur) % 16 !== 0) {
                        throw new OrmException(Code::CODEC_DECODE, 'aes: ciphertext length ' . strlen($cur));
                    }
                    $cur = openssl_decrypt($cur, 'aes-128-ecb', self::foldKey($aesKey), OPENSSL_RAW_DATA);
                    if ($cur === false) {
                        throw new OrmException(Code::CODEC_DECODE, 'aes: bad padding'); // wrong key or corrupt data
                    }
                    break;
                case 'ip':
                    return self::unpackIp($cur);
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "host style {$styles[$i]}");
            }
        }
        return $cur;
    }

    /** INET6_ATON: 4 bytes for IPv4 (an IPv4-mapped IPv6 address included), 16 for IPv6. */
    private static function packIp(string $s): string
    {
        $b = @inet_pton(trim($s));
        if ($b === false) {
            throw new OrmException(Code::CODEC_ENCODE, "ip: \"$s\" is not an address");
        }
        if (strlen($b) === 16 && substr($b, 0, 12) === "\0\0\0\0\0\0\0\0\0\0\xff\xff") {
            return substr($b, 12);
        }
        return $b;
    }

    /** INET6_NTOA. */
    private static function unpackIp(string $b): string
    {
        $n = strlen($b);
        if ($n !== 4 && $n !== 16) {
            throw new OrmException(Code::CODEC_DECODE, "ip: $n packed bytes");
        }
        return inet_ntop($b);
    }

    /**
     * Decodes every styled cell of a positional row in place (joins included): the host stages
     * first (Assemble::index split them off as 'host'), then the codec stages ('codec').
     */
    public static function decodeRow(array &$vals, array $asm): void
    {
        foreach ($asm['columns'] as $c) {
            if (empty($c['styles'])) {
                continue;
            }
            $v = $vals[$c['index']];
            if (!empty($c['host'])) {
                $v = self::hostDecode($v, $c['host'], Orm::config()->aesKey);
            }
            if (!empty($c['codec'])) {
                $v = self::decode($c['codec'], $v);
            } elseif (is_resource($v)) {
                $v = stream_get_contents($v);
            }
            $vals[$c['index']] = $v;
        }
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join') {
                self::decodeRow($vals, $ch['assemble']);
            }
        }
    }

    /** @param array $asm */
    public static function hasStyled(array $asm): bool
    {
        foreach ($asm['columns'] as $c) {
            if (!empty($c['styles'])) {
                return true;
            }
        }
        foreach ($asm['children'] ?? [] as $ch) {
            if ($ch['kind'] === 'join' && self::hasStyled($ch['assemble'])) {
                return true;
            }
        }
        return false;
    }

    /** unserialize gives PHP arrays as-is; nothing to change in the value model (int keys stay int keys). */
    private static function normalize(mixed $v): mixed
    {
        return $v;
    }
}

/** A binary value to bind as a blob (bytea/BLOB): the raw AES output or a packed address a host stage produced. */
final class Bytes
{
    public function __construct(public readonly string $bytes) {}
}
