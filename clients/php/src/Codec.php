<?php
declare(strict_types=1);

namespace Orm;

use Symfony\Component\Yaml\Yaml;
use function OrderedJson\parse as orderedJsonParse;
use function OrderedJson\stringify as orderedJsonStringify;

/**
 * Column-style codecs (docs/codec.md). Styles are in write order; decode applies them in reverse.
 * The host stages (aes/hex/ip) are the ones a dialect leaves to the executor (docs/dialects.md):
 * MySQL runs them in SQL, PostgreSQL asks for aes/hex, SQLite for all three. They come first on
 * write (before the codec stages already applied by the builder) and last on read.
 */
final class Codec
{
    /** Returns the stable lowercase HMAC-SHA256 index for plaintext. */
    public static function blindIndex(mixed $v, string $key): ?string
    {
        if ($v === null) return null;
        if ($key === '') throw new OrmException(Code::CONFIG, 'secret blind_index not configured');
        $plain = $v instanceof Bytes ? $v->bytes : (is_string($v) ? $v : (string) $v);
        return hash_hmac('sha256', $plain, $key);
    }
    /** @return array{float, float} */
    public static function point(mixed $value): array
    {
        if (is_array($value) && array_is_list($value) && count($value) === 2) {
            $parts = $value;
        } elseif (is_string($value)) {
            $text = trim($value);
            if (preg_match('/^POINT\s*\(([^()]*)\)$/i', $text, $m) === 1 || preg_match('/^\(([^()]*)\)$/', $text, $m) === 1) {
                $parts = preg_split('/[\s,]+/', trim($m[1]));
            } else {
                $parts = [];
            }
        } else {
            $parts = [];
        }
        if (count($parts) !== 2 || !is_numeric($parts[0]) || !is_numeric($parts[1])) {
            throw new OrmException(Code::CODEC_DECODE, 'point requires two numeric coordinates');
        }
        $point = [(float) $parts[0], (float) $parts[1]];
        if (!is_finite($point[0]) || !is_finite($point[1])) {
            throw new OrmException(Code::CODEC_DECODE, 'point coordinates must be finite');
        }
        return $point;
    }

    /** @param array{float|int, float|int} $point */
    public static function pointText(array $point): string
    {
        try {
            [$x, $y] = self::point($point);
        } catch (OrmException $e) {
            throw new OrmException(Code::CODEC_ENCODE, $e->getMessage());
        }
        return 'POINT(' . self::pointNumber($x) . ' ' . self::pointNumber($y) . ')';
    }

    /** @param array{float|int, float|int} $point */
    public static function postgresPointText(array $point): string
    {
        try {
            [$x, $y] = self::point($point);
        } catch (OrmException $e) {
            throw new OrmException(Code::CODEC_ENCODE, $e->getMessage());
        }
        return '(' . self::pointNumber($x) . ',' . self::pointNumber($y) . ')';
    }

    private static function pointNumber(float $value): string
    {
        if ($value === 0.0) {
            return '0';
        }
        $text = json_encode($value, JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR);
        return str_ends_with($text, '.0') ? substr($text, 0, -2) : $text;
    }
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
                        $v = json_decode(orderedJsonStringify(orderedJsonParse($v)), true, 512, JSON_THROW_ON_ERROR);
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
                    $cur = orderedJsonStringify(orderedJsonParse(json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)));
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

    // ---- host stages: authenticated AES envelope, hex (upper-case), ip (INET6_ATON packing) ----

    /** Whether a style is a host stage rather than a codec stage. */
    public static function isHostStyle(string $style): bool
    {
        return $style === 'aes' || $style === 'hex' || $style === 'ip';
    }

    /**
     * Derives the cross-client AES-256-GCM key for the v2 envelope.
     */
    private static function aesV2Key(string $key): string
    {
        return hash('sha256', "polyspec/orm/aes-256-gcm/v2\0" . $key, true);
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
                    $nonce = random_bytes(12);
                    $tag = '';
                    $encrypted = openssl_encrypt($cur, 'aes-256-gcm', self::aesV2Key($aesKey), OPENSSL_RAW_DATA, $nonce, $tag, "ORM-AES2\0", 16);
                    $cur = "ORM-AES2\0" . $nonce . $encrypted . $tag;
                    if ($encrypted === false) {
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
                    $prefix = "ORM-AES2\0";
                    if (!str_starts_with($cur, $prefix)) {
                        throw new OrmException(Code::CODEC_DECODE, 'aes: unsupported ciphertext format');
                    }
                    if (strlen($cur) < strlen($prefix) + 12 + 16) {
                        throw new OrmException(Code::CODEC_DECODE, 'aes: truncated v2 envelope');
                    }
                    $offset = strlen($prefix);
                    $nonce = substr($cur, $offset, 12);
                    $tag = substr($cur, -16);
                    $ciphertext = substr($cur, $offset + 12, -16);
                    $plain = openssl_decrypt($ciphertext, 'aes-256-gcm', self::aesV2Key($aesKey), OPENSSL_RAW_DATA, $nonce, $tag, $prefix);
                    if ($plain === false) throw new OrmException(Code::CODEC_DECODE, 'aes: authentication failed');
                    $cur = $plain;
                    break;
                case 'ip':
                    return self::unpackIp($cur);
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "host style {$styles[$i]}");
            }
        }
        return $cur;
    }

    public static function hostDecodeVersioned(mixed $raw, array $styles, int $version, AesKeyring $keyring): ?string
    {
        return self::hostDecode($raw, $styles, $keyring->key($version));
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
        $config = Orm::config();
        $hasAes = false;
        foreach ($asm['columns'] as $c) { if (in_array('aes', $c['styles'] ?? [], true)) { $hasAes = true; break; } }
        $keyring = $hasAes ? ($config->aesKeys === [] ? new AesKeyring([$config->aesVersion => $config->aesKey], $config->aesVersion) : new AesKeyring($config->aesKeys, $config->aesVersion)) : null;
        $version = $config->aesVersion;
        foreach ($asm['columns'] as $c) {
            if (!empty($c['hidden']) && ($c['column'] ?? '') === 'aes_key_version') {
                $version = (int) $vals[$c['index']];
                break;
            }
        }
        foreach ($asm['columns'] as $c) {
            if (empty($c['styles'])) {
                continue;
            }
            $v = $vals[$c['index']];
            if (!empty($c['host'])) {
                $v = in_array('aes', $c['host'], true)
                    ? self::hostDecodeVersioned($v, $c['host'], $version, $keyring)
                    : self::hostDecode($v, $c['host'], $config->aesKey);
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
