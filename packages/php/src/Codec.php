<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\OrderedJson\Value;
use Purr\Yaml\Document;
use Purr\Yaml\Dumper\Dumper;
use Purr\Yaml\Node\AbstractNode;
use Purr\Yaml\Node\AliasNode;
use Purr\Yaml\Node\CollectionStyle;
use Purr\Yaml\Node\MappingEntry;
use Purr\Yaml\Node\MappingEntryList;
use Purr\Yaml\Node\MappingNode;
use Purr\Yaml\Node\NodeList;
use Purr\Yaml\Node\ScalarNode;
use Purr\Yaml\Node\ScalarStyle;
use Purr\Yaml\Node\SequenceNode;
use Purr\Yaml\Exception\ParseException;
use Purr\Yaml\Exception\ReferenceException;
use Purr\Yaml\Schema\CoreSchema;
use Purr\Yaml\YamlStream;

use function Polyspec\OrderedJson\parse as orderedJsonParse;
use function Polyspec\OrderedJson\stringify as orderedJsonStringify;

/**
 * Column-style codecs (docs/spec/codec.md). Styles are in write order; decode applies them in reverse.
 * The host stages (aes/hex/ip) are the ones a dialect leaves to the executor (docs/spec/dialects.md):
 * MySQL runs them in SQL, PostgreSQL asks for aes/hex, SQLite for all three. They come first on
 * write (before the codec stages already applied by the builder) and last on read.
 */
final class Codec
{
    /** Returns the stable lowercase HMAC-SHA256 index for plaintext. */
    public static function blindIndex(mixed $v, string $key): ?string
    {
        if ($v === null) {
            return null;
        }
        if ($key === '') {
            throw new OrmException(Code::CONFIG, 'secret blind_index not configured');
        }
        return hash_hmac('sha256', self::plainBytes($v, 'blind index'), $key);
    }

    /** The bytes of a plaintext: Bytes as given and a string as its bytes; another kind is CODEC_ENCODE (COD-1). */
    private static function plainBytes(mixed $v, string $what): string
    {
        if ($v instanceof Bytes) {
            return $v->bytes;
        }
        if (!is_string($v)) {
            throw new OrmException(Code::CODEC_ENCODE, "$what input must be text or bytes, got " . get_debug_type($v));
        }
        return $v;
    }

    /**
     * Refuses a style that no stage names and a value stage outside the first position, before any value or cell is
     * read (docs/spec/codec.md COD-35).
     * @param list<string> $styles
     */
    private static function checkStyles(array $styles): void
    {
        foreach ($styles as $i => $st) {
            if (in_array($st, ['serialize', 'yaml', 'ordered_json'], true)) {
                if ($i !== 0) {
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "$st must be the first style");
                }
            } elseif ($st !== 'gz' && $st !== 'base64') {
                throw new OrmException(Code::CODEC_UNSUPPORTED, "style $st");
            }
        }
    }
    /** @param list<string> $styles */
    public static function decode(array $styles, mixed $raw): StyledValue
    {
        self::checkStyles($styles);
        if (is_resource($raw)) {
            $raw = stream_get_contents($raw); // pdo_pgsql hands bytea columns over as streams
        }
        if ($raw === null) {
            return StyledValue::sqlNull();
        }
        // An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage, whose encoders write an
        // empty cell for empty text (docs/spec/codec.md COD-14).
        if ($raw === '' && $styles !== [] && end($styles) !== 'base64') {
            throw new OrmException(Code::CODEC_DECODE, 'styled cell is empty');
        }
        if (!is_string($raw)) {
            throw new OrmException(Code::CODEC_DECODE, 'cell is not a string');
        }
        $v = $raw;
        for ($i = count($styles) - 1; $i >= 0; $i--) {
            switch ($styles[$i]) {
                case 'gz':
                    // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- a bad stream returns false, reported as CODEC_DECODE below
                    $v = @gzuncompress($v);
                    if ($v === false) {
                        throw new OrmException(Code::CODEC_DECODE, 'gz: bad zlib stream');
                    }
                    break;
                case 'base64':
                    // A stored cell is decoded only in the form the encoder writes: no whitespace, no line
                    // breaks, no missing padding, no non-zero padding bit is CODEC_DECODE
                    // (docs/spec/codec.md). PHP's strict mode also accepts whitespace and missing padding, so
                    // re-encode the text and check that it is the same.
                    $decoded = base64_decode($v, true);
                    $v = $decoded !== false && base64_encode($decoded) === $v ? $decoded : false;
                    if ($v === false) {
                        throw new OrmException(Code::CODEC_DECODE, 'base64: bad input');
                    }
                    break;
                case 'serialize':
                    $refusal = self::serializedRefusal($v);
                    if ($refusal !== null) {
                        throw $refusal;
                    }
                    // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- a bad format returns false, reported as CODEC_DECODE below
                    $v = @unserialize($v, ['allowed_classes' => false]);
                    if ($v === false && $raw !== serialize(false)) {
                        throw new OrmException(Code::CODEC_DECODE, 'serialize: bad format');
                    }
                    $v = self::normalize($v);
                    // A float of the common value model is finite (COD-16), so INF, -INF and NAN are not values.
                    if (!self::finiteValue($v)) {
                        throw new OrmException(Code::CODEC_DECODE, 'serialize: non-finite numbers are not supported');
                    }
                    break;
                case 'yaml':
                    try {
                        $v = self::yamlDecode($v);
                        self::validateCommonValue($v);
                    } catch (ParseException | ReferenceException | \InvalidArgumentException $e) {
                        throw new OrmException(Code::CODEC_DECODE, 'yaml: ' . $e->getMessage(), $e);
                    }
                    break;
                case 'ordered_json':
                    // The ordered-json value keeps the member order, the number text, and {} apart from [].
                    try {
                        $v = orderedJsonParse($v);
                    } catch (\InvalidArgumentException $e) {
                        throw new OrmException(Code::CODEC_DECODE, 'json: ' . $e->getMessage(), $e);
                    }
                    break;
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "style {$styles[$i]}");
            }
        }
        // Without a value stage (no stage, or a list that starts with gz or base64) the value is the text of the bytes.
        if (in_array($styles[0] ?? null, [null, 'gz', 'base64'], true) && preg_match('//u', $v) !== 1) {
            throw new OrmException(Code::CODEC_DECODE, 'decoded text is not valid UTF-8');
        }
        return StyledValue::value($v);
    }

    /**
     * Encodes a value with the column's styles in write order. A gz result is binary and comes back as Bytes
     * so the executor binds it as a blob (bytea on PostgreSQL rejects it as text); everything else is text.
     * If gz or base64 is the first stage, the value of StyledValue is the string that stage encodes.
     * @param list<string> $styles
     */
    public static function encode(array $styles, StyledValue $v): string|Bytes|null
    {
        self::checkStyles($styles);
        if ($v->kind === 'sql-null') {
            return null;
        }
        $value = $v->payload();
        $cur = $value;
        // A first gz or base64 stage encodes the string, and an empty stage list writes it as it is.
        if (in_array($styles[0] ?? null, [null, 'gz', 'base64'], true) && !is_string($value)) {
            throw new OrmException(Code::CODEC_ENCODE, ($styles[0] ?? 'an empty stage list') . ': the value is '
                . get_debug_type($value) . ', not a string');
        }
        if ($styles === []) {
            return $value;
        }
        foreach ($styles as $st) {
            switch ($st) {
                case 'serialize':
                    // serialize writes any PHP value, a Bytes or an ordered-json object among them; the stage
                    // writes the common value model only (COD-16, COD-63).
                    try {
                        self::validateCommonValue($value);
                    } catch (\InvalidArgumentException $e) {
                        throw new OrmException(Code::CODEC_ENCODE, 'serialize: ' . $e->getMessage(), $e);
                    }
                    $cur = serialize($value);
                    break;
                case 'yaml':
                    try {
                        self::validateCommonValue($value);
                        $cur = (new Dumper())->dumpDocument(new Document(self::yamlNodeOf($value))) . "\n";
                    } catch (\InvalidArgumentException $e) {
                        throw new OrmException(Code::CODEC_ENCODE, 'yaml: ' . $e->getMessage(), $e);
                    }
                    break;
                case 'ordered_json':
                    try {
                        $cur = orderedJsonStringify(orderedJsonParse(self::jsonText($value)));
                    } catch (\JsonException | \InvalidArgumentException $e) {
                        throw new OrmException(Code::CODEC_ENCODE, 'json: ' . $e->getMessage(), $e);
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

    /**
     * Reads one YAML 1.2 document with purrphp/yaml and resolves its plain scalars by the library's
     * core schema. The codec's own rules (docs/spec/codec.md, yaml) apply on the node model: one document,
     * no aliases, anchors or explicit tags, no duplicate keys, string or integral keys; << is an ordinary key, since
     * YAML 1.2 has no merge key (COD-29), so the node model is read without the library's merge (ValueBuilder).
     * A text without a document (empty or only comments) is not a YAML value and is refused.
     */
    private static function yamlDecode(string $text): mixed
    {
        self::yamlStream($text);
        $documents = (new YamlStream())->fromString($text);
        switch (count($documents)) {
            case 0:
                throw new \InvalidArgumentException('no document');
            case 1:
                return self::yamlNode($documents->at(0)->getRoot(), new CoreSchema());
            default:
                throw new \InvalidArgumentException('multiple documents are not supported');
        }
    }

    /**
     * The stream rules of YAML 1.2 that the reader does not apply (docs/spec/codec.md COD-13): the stream is UTF-8,
     * a byte order mark may start it (5.2) and appears nowhere else, and every character is printable (5.1,
     * c-printable).
     */
    private static function yamlStream(string $text): void
    {
        if (!mb_check_encoding($text, 'UTF-8')) {
            throw new \InvalidArgumentException('the stream is not UTF-8');
        }
        $stream = str_starts_with($text, "\u{FEFF}") ? substr($text, 3) : $text;
        $notPrintable = '/[^\t\n\r\x{20}-\x{7E}\x{85}\x{A0}-\x{D7FF}\x{E000}-\x{FEFE}\x{FF00}-\x{FFFD}'
            . '\x{10000}-\x{10FFFF}]/u';
        if (preg_match($notPrintable, $stream, $match, PREG_OFFSET_CAPTURE) === 1) {
            throw new \InvalidArgumentException(sprintf(
                'character U+%04X at byte %d is not printable',
                mb_ord($match[0][0], 'UTF-8'),
                $match[0][1]
            ));
        }
    }

    /**
     * An integer of the core schema outside i64 is not a value of the common value model (COD-16); the reader turns a
     * decimal one into a float and wraps an octal or hexadecimal one, so the plain text is checked here.
     */
    private static function yamlIntegerInRange(ScalarNode $node): void
    {
        if ($node->getStyle() !== ScalarStyle::Plain) {
            return;
        }
        $text = $node->getValue();
        if (preg_match('/^[-+]?[0-9]+$/', $text) === 1) {
            $sign = $text[0] === '-' ? '-' : '';
            $digits = ltrim(ltrim($text, '+-'), '0');
            $inRange = filter_var($sign . ($digits === '' ? '0' : $digits), FILTER_VALIDATE_INT) !== false;
        } elseif (preg_match('/^0o0*([0-7]+)$/', $text, $m) === 1) {
            // 2^63 - 1 is 21 octal digits, all 7.
            $inRange = strlen($m[1]) <= 21;
        } elseif (preg_match('/^0x0*([0-9a-fA-F]+)$/', $text, $m) === 1) {
            $inRange = strlen($m[1]) < 16
                || (strlen($m[1]) === 16 && strcmp(strtolower($m[1]), '7fffffffffffffff') <= 0);
        } else {
            return;
        }
        if (!$inRange) {
            throw new \InvalidArgumentException("integer {$text} at line {$node->getLine()} is outside the i64 range");
        }
    }

    private static function yamlNode(AbstractNode $node, CoreSchema $schema): mixed
    {
        if ($node instanceof AliasNode) {
            throw new \InvalidArgumentException("aliases are not supported at line {$node->getLine()}");
        }
        if ($node->hasAnchor()) {
            throw new \InvalidArgumentException("anchors are not supported at line {$node->getLine()}");
        }
        if ($node->findTag() !== null) {
            throw new \InvalidArgumentException("tag {$node->findTag()} at line {$node->getLine()} is not supported");
        }
        if ($node instanceof ScalarNode) {
            self::yamlIntegerInRange($node);
            return $schema->resolve($node);
        }
        if ($node instanceof SequenceNode) {
            $out = [];
            foreach ($node->getItems() as $item) {
                $out[] = self::yamlNode($item, $schema);
            }
            return $out;
        }
        if ($node instanceof MappingNode) {
            $out = [];
            foreach ($node->getEntries() as $entry) {
                $key = self::yamlNode($entry->getKey(), $schema);
                if (!is_string($key) && !is_int($key)) {
                    throw new \InvalidArgumentException(
                        "map keys must be strings or integers at line {$entry->getKey()->getLine()}"
                    );
                }
                if (array_key_exists($key, $out)) {
                    throw new \InvalidArgumentException(
                        "duplicate map key {$key} at line {$entry->getKey()->getLine()}"
                    );
                }
                $out[$key] = self::yamlNode($entry->getValue(), $schema);
            }
            return $out;
        }
        throw new \InvalidArgumentException('node ' . get_debug_type($node) . ' is not supported');
    }

    private static function finiteValue(mixed $value): bool
    {
        if (is_float($value)) {
            return is_finite($value);
        }
        if (is_array($value)) {
            foreach ($value as $item) {
                if (!self::finiteValue($item)) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * The YAML node of a common value, which the Dumper of purrphp/yaml writes. A string, a key or a value, is
     * double-quoted, so the core schema reads it as a string and each character outside c-printable is its escape
     * (COD-29); a float is written by its shortest text with its fraction, so it reads back as a float; a key is the
     * string of a PHP array key.
     */
    private static function yamlNodeOf(mixed $value): AbstractNode
    {
        return match (true) {
            $value === null => new ScalarNode('null'),
            is_bool($value) => new ScalarNode($value ? 'true' : 'false'),
            is_int($value) => new ScalarNode((string) $value),
            is_float($value) => new ScalarNode(json_encode($value, JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR)),
            is_string($value) => new ScalarNode($value, ScalarStyle::DoubleQuoted),
            $value === [] => new SequenceNode(new NodeList(), CollectionStyle::Flow),
            is_array($value) && array_is_list($value) => new SequenceNode(
                new NodeList(...array_map(self::yamlNodeOf(...), $value))
            ),
            is_array($value) => new MappingNode(new MappingEntryList(...array_map(
                static fn (int|string $key, mixed $item): MappingEntry => new MappingEntry(
                    new ScalarNode((string) $key, ScalarStyle::DoubleQuoted),
                    self::yamlNodeOf($item),
                ),
                array_keys($value),
                $value,
            ))),
            default => throw new \InvalidArgumentException('value type is not supported'),
        };
    }

    private static function validateCommonValue(mixed $value): void
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
            self::validateCommonValue($item);
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
        if ($styles === []) {
            throw new OrmException(Code::CODEC_ENCODE, 'host style list is empty');
        }
        foreach ($styles as $st) {
            if (!in_array($st, ['aes', 'hex', 'ip'], true)) {
                throw new OrmException(Code::CODEC_UNSUPPORTED, "host style $st");
            }
        }
        if ($v === null) {
            return null;
        }
        $cur = self::plainBytes($v, 'host');
        foreach ($styles as $st) {
            switch ($st) {
                case 'aes':
                    if ($aesKey === '') {
                        throw new OrmException(Code::CONFIG, 'secret aes not configured');
                    }
                    $nonce = random_bytes(12);
                    $tag = '';
                    $encrypted = openssl_encrypt(
                        $cur,
                        'aes-256-gcm',
                        self::aesV2Key($aesKey),
                        OPENSSL_RAW_DATA,
                        $nonce,
                        $tag,
                        "ORM-AES2\0",
                        16
                    );
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
                    $cur = strlen($cur) % 2 === 0 && strspn($cur, '0123456789ABCDEF') === strlen($cur)
                        ? hex2bin($cur) : false;
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
                    $plain = openssl_decrypt(
                        $ciphertext,
                        'aes-256-gcm',
                        self::aesV2Key($aesKey),
                        OPENSSL_RAW_DATA,
                        $nonce,
                        $tag,
                        $prefix
                    );
                    if ($plain === false) {
                        throw new OrmException(Code::CODEC_DECODE, 'aes: authentication failed');
                    }
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

    /** INET6_ATON: 4 bytes for IPv4 and 16 for IPv6, an IPv4-mapped address included (COD-38). */
    private static function packIp(string $s): string
    {
        // The exact text only: white space around the address is CODEC_ENCODE (docs/spec/codec.md).
        // inet_pton throws a ValueError on a NUL byte, which is not an address either, and accepts a zone (%eth0),
        // which is no part of one (COD-38).
        // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- a text that is no address returns false, reported as CODEC_ENCODE below
        $b = str_contains($s, "\0") || str_contains($s, '%') ? false : @inet_pton($s);
        if ($b === false) {
            throw new OrmException(Code::CODEC_ENCODE, "ip: \"$s\" is not an address");
        }
        return $b;
    }

    /** INET6_NTOA: the RFC 5952 text, an IPv4-mapped address as ::ffff:a.b.c.d (section 5). */
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
                    if ($aes && $versionIndex === null) {
                        // The planner selects the version column of every AES column, so a plan without one is broken:
                        // no version is assumed.
                        throw new OrmException(Code::INTERNAL, 'an AES column has no version column');
                    }
                    // The version is read only for a non-NULL value: a NULL cell with a NULL version stays NULL
                    // (COD-44).
                    if ($v !== null) {
                        $key = !$aes ? $config->aesKey : $keyring->key(self::rowVersion($vals, $versionIndex));
                        $v = self::hostDecode($v, $host, $key);
                    }
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

    /**
     * The key version of a read row's version cell (COD-44): a missing cell is INTERNAL, a stored version that is not a
     * positive 32-bit integer is CODEC_DECODE.
     * @param array<array-key, mixed> $vals
     */
    private static function rowVersion(array $vals, int $index): int
    {
        if (!array_key_exists($index, $vals)) {
            throw new OrmException(Code::INTERNAL, "the AES version cell $index is missing from the row");
        }
        return AesKeyring::storedVersion($vals[$index]);
    }

    /**
     * The refusal of a serialized text that unserialize would read without an error: a value that starts with O:,
     * C:, R: or r: is CODEC_UNSUPPORTED (COD-34), and an integer outside i64 is CODEC_DECODE (COD-16), since
     * unserialize clamps it to PHP_INT_MAX or PHP_INT_MIN. The walk reads each value by its type letter and skips a
     * string by its byte length, so the letters inside a string are text; it stops at the first value it cannot read
     * and leaves that format failure to unserialize.
     */
    private static function serializedRefusal(string $text): ?OrmException
    {
        $at = 0;
        $length = strlen($text);
        while ($at < $length) {
            $type = $text[$at];
            if (in_array($type, ['O', 'C', 'R', 'r'], true) && substr($text, $at + 1, 1) === ':') {
                return new OrmException(Code::CODEC_UNSUPPORTED, 'serialize: objects and references are not supported');
            }
            if ($type === '}' || $type === 'N' && substr($text, $at, 2) === 'N;') {
                $at += $type === '}' ? 1 : 2;
                continue;
            }
            if ($type === 's' && preg_match('/\Gs:(\d+):"/', $text, $m, 0, $at) === 1) {
                $at += strlen($m[0]) + (int) $m[1] + 2;
                continue;
            }
            if ($type === 'a' && preg_match('/\Ga:\d+:\{/', $text, $m, 0, $at) === 1) {
                $at += strlen($m[0]);
                continue;
            }
            if (preg_match('/\G([bid]):([^;]*);/', $text, $m, 0, $at) === 1) {
                if ($m[1] === 'i' && !self::serializedI64($m[2])) {
                    return new OrmException(Code::CODEC_DECODE, "serialize: integer {$m[2]} is outside the i64 range");
                }
                $at += strlen($m[0]);
                continue;
            }
            return null;
        }
        return null;
    }

    /** Whether the text of a serialized integer, with its optional sign and leading zeros, is in the i64 range. */
    private static function serializedI64(string $digits): bool
    {
        if (preg_match('/^([+-]?)0*([0-9]+)$/', $digits, $m) !== 1) {
            return true;
        }
        $limit = $m[1] === '-' ? '9223372036854775808' : '9223372036854775807';
        return strlen($m[2]) < strlen($limit) || strlen($m[2]) === strlen($limit) && strcmp($m[2], $limit) <= 0;
    }

    /** unserialize gives PHP arrays as-is; nothing to change in the value model (int keys stay int keys). */
    private static function normalize(mixed $v): mixed
    {
        return $v;
    }
}
