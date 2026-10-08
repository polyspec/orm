<?php
declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\OrderedJson\Value;
use Symfony\Component\Yaml\Yaml;
use function Polyspec\OrderedJson\parse as orderedJsonParse;
use function Polyspec\OrderedJson\stringify as orderedJsonStringify;

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
    /** @param list<string> $styles */
    public static function decode(array $styles, mixed $raw): StyledValue
    {
        if (is_resource($raw)) {
            $raw = stream_get_contents($raw); // pdo_pgsql hands bytea columns over as streams
        }
        if ($raw === null) {
            return StyledValue::sqlNull();
        }
        if ($raw === '') {
            throw new OrmException(Code::CODEC_DECODE, 'styled cell is empty');
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
                case 'ordered_json':
                    // The ordered-json value keeps the member order, the number text, and {} apart from [].
                    try {
                        $v = orderedJsonParse($v);
                    } catch (\InvalidArgumentException $e) {
                        throw new OrmException(Code::CODEC_DECODE, 'json: ' . $e->getMessage());
                    }
                    break;
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "style {$styles[$i]}");
            }
        }
        return StyledValue::value($v);
    }

    /**
     * Encodes a value with the column's styles in write order. A gz result is binary and comes back as Bytes
     * so the executor binds it as a blob (bytea on PostgreSQL rejects it as text); everything else is text.
     * gz나 base64가 첫 stage면 StyledValue의 값은 그 stage가 encode하는 string이다.
     * @param list<string> $styles
     */
    public static function encode(array $styles, StyledValue $v): string|Bytes|null
    {
        if ($v->kind === 'sql-null') {
            return null;
        }
        $value = $v->payload();
        $cur = $value;
        if (in_array($styles[0], ['gz', 'base64'], true) && !is_string($value)) {
            throw new OrmException(Code::CODEC_ENCODE, "{$styles[0]}: the value is " . get_debug_type($value) . ', not a string');
        }
        foreach ($styles as $i => $st) {
            switch ($st) {
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
                case 'ordered_json':
                    try {
                        $cur = orderedJsonStringify(orderedJsonParse(self::jsonText($value)));
                    } catch (\JsonException | \InvalidArgumentException $e) {
                        throw new OrmException(Code::CODEC_ENCODE, 'json: ' . $e->getMessage());
                    }
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

    /**
     * The JSON text of an ordered-json value or of the common value model. An
     * ordered-json value, also inside an array, is written as its compact text.
     */
    private static function jsonText(mixed $value): string
    {
        if ($value instanceof Value) {
            return orderedJsonStringify($value);
        }
        if (is_array($value)) {
            $parts = [];
            if (array_is_list($value)) {
                foreach ($value as $item) {
                    $parts[] = self::jsonText($item);
                }
                return '[' . implode(',', $parts) . ']';
            }
            foreach ($value as $key => $item) {
                $parts[] = self::jsonText((string) $key) . ':' . self::jsonText($item);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if ($value instanceof \stdClass) {
            $parts = [];
            foreach (get_object_vars($value) as $key => $item) {
                $parts[] = self::jsonText((string) $key) . ':' . self::jsonText($item);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if ($value instanceof \JsonSerializable) {
            return self::jsonText($value->jsonSerialize());
        }
        if (is_object($value) || is_resource($value)) {
            throw new OrmException(Code::CODEC_ENCODE, 'json: ' . get_debug_type($value) . ' is not a JSON value');
        }
        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
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
        static $derived = [];
        return $derived[$key] ??= hash('sha256', "polyspec/orm/aes-256-gcm/v2\0" . $key, true);
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
     * Decodes the styled cells of positional rows in place: the host stages first, then the codec
     * stages. $cells is a step's 'decode' list from Assemble::index (joined columns included):
     * [index, host stages, codec stages, whether the host stages include aes, the index of the
     * node's aes_key_version column or null].
     * @param list<list<mixed>> $rows
     * @param list<array{0: int, 1: list<string>, 2: list<string>, 3: bool, 4: ?int}> $cells
     */
    public static function decodeRows(array &$rows, array $cells, Config $config): void
    {
        $keyring = null;
        foreach ($cells as $c) {
            if ($c[3]) {
                $keyring = $config->keyring();
                break;
            }
        }
        foreach ($rows as &$vals) {
            foreach ($cells as [$index, $host, $codec, $aes, $versionIndex]) {
                $v = $vals[$index];
                if ($host !== []) {
                    $key = !$aes ? $config->aesKey
                        : $keyring->key($versionIndex === null ? $config->aesVersion : (int) $vals[$versionIndex]);
                    $v = self::hostDecode($v, $host, $key);
                }
                if ($codec !== []) {
                    $v = self::decode($codec, $v);
                } elseif (is_resource($v)) {
                    $v = stream_get_contents($v);
                }
                $vals[$index] = $v;
            }
        }
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
