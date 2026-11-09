<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\OrderedJson\ParseError;
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
use Purr\Yaml\Exception\ReferenceException;
use Purr\Yaml\Schema\CoreSchema;
use Purr\Yaml\YamlStream;

use function Polyspec\OrderedJson\parse as orderedJsonParse;

/**
 * Column-style codecs (docs/spec/codec.md). Styles are in write order; decode applies them in reverse.
 * The host stages (aes/hex/ip) are the ones a dialect leaves to the executor (docs/spec/dialects.md):
 * MySQL runs them in SQL, PostgreSQL asks for aes/hex, SQLite for all three. They come first on
 * write (before the codec stages already applied by the builder) and last on read.
 *
 * Each refusal is a rule of COD-70 with its code and its one text, which names no value and no position; a failure of a
 * library is the error of its rule with the failure kept as the previous exception (COD-71), and no exception of a
 * library leaves a call.
 */
final class Codec
{
    /** The nesting that the ordered-json parser reads (json-depth of COD-70). */
    private const int JSON_DEPTH = 256;

    /** The nesting that every value stage reads and writes, the outermost list or map at level 1 (COD-70). */
    private const int DEPTH = 256;

    /** The text of the nesting rules of COD-70, after the stage. */
    private const string DEPTH_RULE = 'value nesting exceeds 256 levels';

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

    /**
     * The bytes of a plaintext: Bytes as given and a string as its bytes; another kind is CODEC_ENCODE (COD-1), and a
     * string that is not UTF-8 is no sequence of Unicode scalar values (host-input-unicode).
     */
    private static function plainBytes(mixed $v, string $what): string
    {
        if ($v instanceof Bytes) {
            return $v->bytes;
        }
        if (!is_string($v)) {
            throw new OrmException(Code::CODEC_ENCODE, "$what input must be text or bytes");
        }
        if (!mb_check_encoding($v, 'UTF-8')) {
            throw new OrmException(Code::CODEC_ENCODE, "$what input is not a sequence of Unicode scalar values");
        }
        return $v;
    }

    /**
     * Runs a library call that reports its failure only by returning false (COD-71): its result and, on false, the
     * cause, an exception that holds the warning of the call or, when the call warns of nothing, its name.
     *
     * @return array{mixed, ?\RuntimeException}
     */
    private static function libraryCall(string $name, \Closure $call): array
    {
        $warning = null;
        set_error_handler(static function (int $level, string $message) use (&$warning): bool {
            $warning = $message;
            return true;
        });
        try {
            $result = $call();
        } finally {
            restore_error_handler();
        }
        return [$result, $result === false ? new \RuntimeException($warning ?? "$name returned false") : null];
    }

    /** The cause of an OpenSSL call that returned false: the queue of OpenSSL errors, or the name of the call. */
    private static function opensslFailure(string $name): \RuntimeException
    {
        $errors = [];
        while (($error = openssl_error_string()) !== false) {
            $errors[] = $error;
        }
        return new \RuntimeException($errors === [] ? "$name returned false" : implode('; ', $errors));
    }

    /** Empties the queue of OpenSSL errors, so that the queue after a call holds only the errors of that call. */
    private static function opensslClear(): void
    {
        do {
            $error = openssl_error_string();
        } while ($error !== false);
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
        if ($raw instanceof Bytes) {
            $raw = $raw->bytes;
        }
        if ($raw === null) {
            return StyledValue::sqlNull();
        }
        if (!is_string($raw)) {
            throw new OrmException(Code::CODEC_DECODE, 'cell is not bytes');
        }
        // An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage, whose encoders write an
        // empty cell for empty text (docs/spec/codec.md COD-14).
        if ($raw === '' && $styles !== [] && end($styles) !== 'base64') {
            throw new OrmException(Code::CODEC_DECODE, 'styled cell is empty');
        }
        $v = $raw;
        for ($i = count($styles) - 1; $i >= 0; $i--) {
            switch ($styles[$i]) {
                case 'gz':
                    [$v, $cause] = self::libraryCall('gzuncompress', static fn (): string|false => gzuncompress($v));
                    if ($cause !== null) {
                        throw new OrmException(Code::CODEC_DECODE, 'gz: bad zlib stream', $cause);
                    }
                    break;
                case 'base64':
                    // A stored cell is decoded only in the form the encoder writes: no whitespace, no line
                    // breaks, no missing padding, no non-zero padding bit is CODEC_DECODE
                    // (docs/spec/codec.md). PHP's strict mode also accepts whitespace and missing padding, so
                    // re-encode the text and check that it is the same.
                    [$decoded, $cause] = self::libraryCall(
                        'base64_decode',
                        static fn (): string|false => base64_decode($v, true)
                    );
                    if ($cause !== null) {
                        throw new OrmException(Code::CODEC_DECODE, 'base64: bad input', $cause);
                    }
                    if (base64_encode($decoded) !== $v) {
                        throw new OrmException(Code::CODEC_DECODE, 'base64: bad input');
                    }
                    $v = $decoded;
                    break;
                case 'serialize':
                    $v = self::unserialized($v);
                    break;
                case 'yaml':
                    $v = self::yamlDecode($v);
                    break;
                case 'ordered_json':
                    // The ordered-json value keeps the member order, the number text, and {} apart from [].
                    try {
                        $v = orderedJsonParse($v);
                    } catch (ParseError $e) {
                        // The parser names the kind of its refusal; a nesting past its 256 levels is json-depth-read.
                        $rule = $e->kind === 'maximum_depth_exceeded' ? self::DEPTH_RULE : 'the cell is not JSON';
                        throw new OrmException(Code::CODEC_DECODE, "json: $rule", $e);
                    } catch (\Throwable $e) {
                        throw new OrmException(Code::CODEC_DECODE, 'json: the cell is not JSON', $e);
                    }
                    break;
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "style {$styles[$i]}");
            }
        }
        // Without a value stage (no stage, or a list that starts with gz or base64) the value is the text of the bytes.
        if (in_array($styles[0] ?? null, [null, 'gz', 'base64'], true) && !mb_check_encoding($v, 'UTF-8')) {
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
        if (in_array($styles[0] ?? null, [null, 'gz', 'base64'], true)) {
            if (!is_string($value)) {
                $stage = isset($styles[0]) ? "a first {$styles[0]} stage" : 'an empty stage list';
                throw new OrmException(Code::CODEC_ENCODE, "$stage takes a string value");
            }
            if (!mb_check_encoding($value, 'UTF-8')) {
                $stage = isset($styles[0]) ? "{$styles[0]}: " : '';
                $rule = 'the text is not a sequence of Unicode scalar values';
                throw new OrmException(Code::CODEC_ENCODE, $stage . $rule);
            }
        }
        if ($styles === []) {
            return $value;
        }
        foreach ($styles as $st) {
            switch ($st) {
                case 'serialize':
                    // serialize writes any PHP value, a Bytes or an ordered-json object among them; the stage
                    // writes the common value model only (COD-16, COD-63).
                    self::checkCodecValue('serialize', $value);
                    $cur = serialize($value);
                    break;
                case 'yaml':
                    $cur = self::yamlText($value);
                    break;
                case 'ordered_json':
                    $cur = self::orderedJsonText($value);
                    break;
                case 'base64':
                    $cur = base64_encode($cur);
                    break;
                case 'gz':
                    [$cur, $cause] = self::libraryCall('gzcompress', static fn (): string|false => gzcompress($cur, 9));
                    if ($cause !== null) {
                        throw new OrmException(Code::CODEC_ENCODE, 'gz: the compression failed', $cause);
                    }
                    break;
                default:
                    throw new OrmException(Code::CODEC_UNSUPPORTED, "style $st");
            }
        }
        return $styles[count($styles) - 1] === 'gz' ? new Bytes($cur) : $cur;
    }

    /**
     * The rule of COD-70 that a value under a first serialize or yaml stage breaks, or null for a value of the common
     * value model of COD-16: the first node that breaks one, keys before their values, and a list or a map past the 256
     * levels at its start, $depth being the level of its container (serialize-depth-write, yaml-depth-write).
     */
    private static function codecValueRule(mixed $value, int $depth = 0): ?string
    {
        if ($value === null || is_bool($value) || is_int($value)) {
            return null;
        }
        if (is_string($value)) {
            return mb_check_encoding($value, 'UTF-8') ? null : 'the text is not a sequence of Unicode scalar values';
        }
        if (is_float($value)) {
            return is_finite($value) ? null : 'number is not finite';
        }
        if (is_array($value)) {
            if ($depth + 1 > self::DEPTH) {
                return self::DEPTH_RULE;
            }
            foreach ($value as $key => $item) {
                if (is_string($key) && !mb_check_encoding($key, 'UTF-8')) {
                    return 'the text is not a sequence of Unicode scalar values';
                }
                $rule = self::codecValueRule($item, $depth + 1);
                if ($rule !== null) {
                    return $rule;
                }
            }
            return null;
        }
        if ($value instanceof Value) {
            return 'an ordered-json value is written only by the ordered_json stage';
        }
        return 'the value is not a codec value';
    }

    /** Refuses a value under the first stage by the rule it breaks, prefixed by the stage. */
    private static function checkCodecValue(string $stage, mixed $value): void
    {
        $rule = self::codecValueRule($value);
        if ($rule !== null) {
            throw new OrmException(Code::CODEC_ENCODE, "$stage: $rule");
        }
    }

    /**
     * The stored text of an ordered_json write: the JSON text of the value, read by the ordered-json parser and written
     * compact. The rules of the value come first; a failure of the JSON writer or of the parser is json-text.
     */
    private static function orderedJsonText(mixed $value): string
    {
        try {
            $text = self::jsonText($value, 0);
        } catch (\JsonException | \InvalidArgumentException $e) {
            throw new OrmException(Code::CODEC_ENCODE, 'json: the value has no JSON text', $e);
        }
        try {
            return self::compactJsonText(orderedJsonParse($text)->raw());
        } catch (\Throwable $e) {
            throw new OrmException(Code::CODEC_ENCODE, 'json: the value has no JSON text', $e);
        }
    }

    /**
     * The stored text of a JSON text: the insignificant whitespace outside the string literals is removed, and every
     * other byte, the member order and the repeated member names included, stays in place (DIA-26).
     */
    private static function compactJsonText(string $text): string
    {
        $out = '';
        $inString = false;
        $escaped = false;
        $length = strlen($text);
        for ($i = 0; $i < $length; $i++) {
            $c = $text[$i];
            if ($inString) {
                $out .= $c;
                if ($escaped) {
                    $escaped = false;
                } elseif ($c === '\\') {
                    $escaped = true;
                } elseif ($c === '"') {
                    $inString = false;
                }
                continue;
            }
            if ($c === ' ' || $c === "\t" || $c === "\n" || $c === "\r") {
                continue;
            }
            if ($c === '"') {
                $inString = true;
            }
            $out .= $c;
        }
        return $out;
    }

    /** The deepest nesting of arrays and objects in a JSON text, its string literals aside. */
    private static function jsonTextDepth(string $text): int
    {
        $depth = 0;
        $deepest = 0;
        $inString = false;
        $escaped = false;
        $length = strlen($text);
        for ($i = 0; $i < $length; $i++) {
            $c = $text[$i];
            if ($inString) {
                if ($escaped) {
                    $escaped = false;
                } elseif ($c === '\\') {
                    $escaped = true;
                } elseif ($c === '"') {
                    $inString = false;
                }
            } elseif ($c === '"') {
                $inString = true;
            } elseif ($c === '[' || $c === '{') {
                $deepest = max($deepest, ++$depth);
            } elseif ($c === ']' || $c === '}') {
                $depth--;
            }
        }
        return $deepest;
    }

    /**
     * The JSON text of an ordered-json value or of the common value model, at the nesting depth of its container. An
     * ordered-json value, also inside an array, is written as its text. Each node is checked in order: a nesting past
     * the 256 levels of the parser, a string that is not UTF-8, a float that is not finite and a value outside the
     * JSON value model are their rules of COD-70.
     */
    private static function jsonText(mixed $value, int $depth): string
    {
        if ($value instanceof Value) {
            // The source text keeps the member order and the repeated names that the member map collapses (DIA-26).
            $raw = $value->raw();
            if ($depth + self::jsonTextDepth($raw) > self::JSON_DEPTH) {
                throw self::jsonDepthError();
            }
            return $raw;
        }
        if (is_array($value) || $value instanceof \stdClass) {
            if ($depth + 1 > self::JSON_DEPTH) {
                throw self::jsonDepthError();
            }
            $members = is_array($value) ? $value : get_object_vars($value);
            $parts = [];
            if (is_array($value) && array_is_list($value)) {
                foreach ($value as $item) {
                    $parts[] = self::jsonText($item, $depth + 1);
                }
                return '[' . implode(',', $parts) . ']';
            }
            foreach ($members as $key => $item) {
                $parts[] = self::jsonText((string) $key, $depth + 1) . ':' . self::jsonText($item, $depth + 1);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if ($value instanceof \JsonSerializable) {
            return self::jsonText($value->jsonSerialize(), $depth);
        }
        if (is_string($value) && !mb_check_encoding($value, 'UTF-8')) {
            throw new OrmException(Code::CODEC_ENCODE, 'json: the text is not a sequence of Unicode scalar values');
        }
        if (is_float($value) && !is_finite($value)) {
            throw new OrmException(Code::CODEC_ENCODE, 'json: non-finite number');
        }
        if (is_object($value) || is_resource($value)) {
            throw new OrmException(Code::CODEC_ENCODE, 'json: the value is not a JSON value');
        }
        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    }

    private static function jsonDepthError(): OrmException
    {
        return new OrmException(Code::CODEC_ENCODE, 'json: value nesting exceeds ' . self::JSON_DEPTH . ' levels');
    }

    /** The error of a rule of the yaml decode. */
    private static function yamlRule(string $rule, ?\Throwable $cause = null): OrmException
    {
        return new OrmException(Code::CODEC_DECODE, "yaml: $rule", $cause);
    }

    /**
     * Reads one YAML 1.2 document with purrphp/yaml and resolves its plain scalars by the library's
     * core schema. The codec's own rules (docs/spec/codec.md, yaml) apply on the node model: one document,
     * no aliases, anchors or explicit tags, no duplicate keys, string or integral keys; << is an ordinary key, since
     * YAML 1.2 has no merge key (COD-29), so the node model is read without the library's merge (ValueBuilder).
     * A text without a document (empty or only comments) is not a YAML value and is refused. The parser of purrphp/yaml
     * resolves an alias as it reads it and refuses one whose anchor is not in the stream with a ReferenceException,
     * which is yaml-alias; any other failure of the library, a node of a kind that the walk does not read included, is
     * yaml-parse, with the failure as its cause (COD-71, COD-72).
     */
    private static function yamlDecode(string $text): mixed
    {
        self::yamlStream($text);
        try {
            $documents = (new YamlStream())->fromString($text);
            $count = count($documents);
            if ($count === 0) {
                throw self::yamlRule('no document');
            }
            if ($count > 1) {
                throw self::yamlRule('multiple documents are not supported');
            }
            return self::yamlNode($documents->at(0)->getRoot(), new CoreSchema());
        } catch (OrmException $e) {
            throw $e;
        } catch (ReferenceException $e) {
            throw self::yamlRule('aliases are not supported', $e);
        } catch (\Throwable $e) {
            throw self::yamlRule('the stream does not parse', $e);
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
            throw self::yamlRule('the stream is not UTF-8');
        }
        $stream = str_starts_with($text, "\u{FEFF}") ? substr($text, 3) : $text;
        $notPrintable = '/[^\t\n\r\x{20}-\x{7E}\x{85}\x{A0}-\x{D7FF}\x{E000}-\x{FEFE}\x{FF00}-\x{FFFD}'
            . '\x{10000}-\x{10FFFF}]/u';
        if (preg_match($notPrintable, $stream) === 1) {
            throw self::yamlRule('the stream holds a character that is not printable');
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
            throw self::yamlRule('integer is outside the i64 range');
        }
    }

    /** The properties of a node that the codec refuses: an alias, an anchor and an explicit tag, in that order. */
    private static function yamlProperties(AbstractNode $node): void
    {
        if ($node instanceof AliasNode) {
            throw self::yamlRule('aliases are not supported');
        }
        if ($node->hasAnchor()) {
            throw self::yamlRule('anchors are not supported');
        }
        if ($node->findTag() !== null) {
            throw self::yamlRule('explicit tags are not supported');
        }
    }

    /**
     * A node as a PHP value, with the rules of the codec. The node model of purrphp/yaml has four kinds (its
     * NodeVisitor): an alias, which yamlProperties refuses, a scalar, a sequence and a mapping, which is the last.
     * A node is met where it starts (COD-70): its properties, then the nesting rule of its level, $depth being the
     * level of its container, then its own rules, and a key before its value.
     */
    private static function yamlNode(AbstractNode $node, CoreSchema $schema, int $depth = 0): mixed
    {
        self::yamlProperties($node);
        if ($node instanceof ScalarNode) {
            self::yamlIntegerInRange($node);
            $value = $schema->resolve($node);
            // A float beyond the f64 range is read as INF, so the rule covers it with .inf and .nan (COD-16).
            if (is_float($value) && !is_finite($value)) {
                throw self::yamlRule('number is not finite');
            }
            return $value;
        }
        self::yamlDepth($depth);
        if ($node instanceof SequenceNode) {
            $out = [];
            foreach ($node->getItems() as $item) {
                $out[] = self::yamlNode($item, $schema, $depth + 1);
            }
            return $out;
        }
        /** @var MappingNode $node */
        $out = [];
        foreach ($node->getEntries() as $entry) {
            $keyNode = $entry->getKey();
            if ($keyNode instanceof SequenceNode || $keyNode instanceof MappingNode) {
                self::yamlProperties($keyNode);
                self::yamlDepth($depth + 1);
                throw self::yamlRule('map keys must be scalar strings');
            }
            $key = self::yamlNode($keyNode, $schema, $depth + 1);
            if (!is_string($key) && !is_int($key)) {
                throw self::yamlRule('map keys must be strings or integers');
            }
            if (array_key_exists($key, $out)) {
                throw self::yamlRule('duplicate map key');
            }
            $out[$key] = self::yamlNode($entry->getValue(), $schema, $depth + 1);
        }
        return $out;
    }

    /** Refuses a sequence or a mapping inside a container at level $depth past the 256 levels (yaml-depth). */
    private static function yamlDepth(int $depth): void
    {
        if ($depth + 1 > self::DEPTH) {
            throw self::yamlRule(self::DEPTH_RULE);
        }
    }

    /**
     * The YAML text of a value under a first yaml stage: the rules of the value, the text that the Dumper of
     * purrphp/yaml writes, and the text read back, which must be the value (yaml-read-back).
     */
    private static function yamlText(mixed $value): string
    {
        self::checkCodecValue('yaml', $value);
        try {
            $text = (new Dumper())->dumpDocument(new Document(self::yamlNodeOf($value))) . "\n";
        } catch (\Throwable $e) {
            throw new OrmException(Code::CODEC_ENCODE, 'yaml: the value has no YAML text', $e);
        }
        try {
            $back = self::yamlDecode($text);
        } catch (OrmException $e) {
            throw new OrmException(Code::CODEC_ENCODE, 'yaml: the written text does not read back as the value', $e);
        }
        if ($back !== $value) {
            throw new OrmException(Code::CODEC_ENCODE, 'yaml: the written text does not read back as the value');
        }
        return $text;
    }

    /**
     * The YAML node of a common value, which the Dumper of purrphp/yaml writes. A string, a key or a value, is
     * double-quoted, so the core schema reads it as a string and each character outside c-printable is its escape
     * (COD-29); a float is written by its shortest text with its fraction, so it reads back as a float; a key is the
     * string of a PHP array key. The value is one that codecValueRule passed, so an array is the last kind.
     *
     * @param null|bool|int|float|string|array<array-key, mixed> $value
     */
    private static function yamlNodeOf(null|bool|int|float|string|array $value): AbstractNode
    {
        return match (true) {
            $value === null => new ScalarNode('null'),
            is_bool($value) => new ScalarNode($value ? 'true' : 'false'),
            is_int($value) => new ScalarNode((string) $value),
            is_float($value) => new ScalarNode(json_encode($value, JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR)),
            is_string($value) => new ScalarNode($value, ScalarStyle::DoubleQuoted),
            $value === [] => new SequenceNode(new NodeList(), CollectionStyle::Flow),
            array_is_list($value) => new SequenceNode(
                new NodeList(...array_map(self::yamlNodeOf(...), $value))
            ),
            default => new MappingNode(new MappingEntryList(...array_map(
                static fn (int|string $key, mixed $item): MappingEntry => new MappingEntry(
                    new ScalarNode((string) $key, ScalarStyle::DoubleQuoted),
                    self::yamlNodeOf($item),
                ),
                array_keys($value),
                $value,
            ))),
        };
    }

    // ---- serialize: a reader of PHP's serialize format ----

    /** The error of a rule of the serialize decode. */
    private static function serializeRule(string $rule): OrmException
    {
        return new OrmException(Code::CODEC_DECODE, "serialize: $rule");
    }

    /** Moves past the delimiter at $at, or refuses the cell as serialize-expected. */
    private static function serializedDelimiter(string $text, int &$at, string $delimiter): void
    {
        if ($at >= strlen($text) || $text[$at] !== $delimiter) {
            throw self::serializeRule("expected $delimiter");
        }
        $at++;
    }

    /** The field from $at up to the delimiter that ends it, moving past the delimiter. */
    private static function serializedField(string $text, int &$at, string $delimiter): string
    {
        $end = strpos($text, $delimiter, $at);
        if ($end === false) {
            throw self::serializeRule("expected $delimiter");
        }
        $field = substr($text, $at, $end - $at);
        $at = $end + 1;
        return $field;
    }

    /** The length of a string or an array: digits only, as the grammar of unserialize reads it. */
    private static function serializedLength(string $field, string $what): int
    {
        if (preg_match('/\A[0-9]+\z/', $field) !== 1) {
            throw self::serializeRule("bad $what length");
        }
        // A length past PHP_INT_MAX is past the end of any cell; the cast gives PHP_INT_MAX.
        return (int) $field;
    }

    /** An i field: an optional sign and digits, in the i64 range (COD-16), which unserialize would clamp. */
    private static function serializedInt(string $field): int
    {
        if (preg_match('/\A([+-]?)0*([0-9]+)\z/', $field, $m) !== 1) {
            throw self::serializeRule('bad int');
        }
        $limit = $m[1] === '-' ? '9223372036854775808' : '9223372036854775807';
        if (strlen($m[2]) > strlen($limit) || (strlen($m[2]) === strlen($limit) && strcmp($m[2], $limit) > 0)) {
            throw self::serializeRule('integer is outside the i64 range');
        }
        return (int) $field;
    }

    /**
     * A d field of the grammar of unserialize: an optional sign, digits with an optional fraction and an optional
     * exponent, or NAN, INF and -INF, which with a float beyond the f64 range are not finite (COD-16).
     */
    private static function serializedFloat(string $field): float
    {
        if ($field === 'NAN' || $field === 'INF' || $field === '-INF') {
            throw self::serializeRule('non-finite float');
        }
        if (preg_match('/\A[+-]?([0-9]*\.[0-9]+|[0-9]+\.[0-9]*|[0-9]+)([eE][+-]?[0-9]+)?\z/', $field) !== 1) {
            throw self::serializeRule('bad float');
        }
        $value = (float) $field;
        if (!is_finite($value)) {
            throw self::serializeRule('non-finite float');
        }
        return $value;
    }

    /**
     * Reads a serialized cell by the grammar of PHP's unserialize, with the rules of COD-70: the values of the common
     * value model (COD-16), no object or reference (COD-34), and nothing after the value. An array opens a frame
     * [items, members left, whether its key is read, key], so a nesting of any depth reads without recursion; an array
     * key is a whole value, an integer or a string, and a key that repeats an earlier one is refused, which unserialize
     * would let replace it; an array past the 256 levels is refused at its start.
     */
    private static function unserialized(string $text): mixed
    {
        $at = 0;
        $length = strlen($text);
        /** @var list<array{0: array<array-key, mixed>, 1: int, 2: bool, 3: int|string}> $open */
        $open = [];
        while (true) {
            if ($at >= $length) {
                throw self::serializeRule('unexpected end');
            }
            $type = $text[$at++];
            if ($type === 'a') {
                // An array is met where it starts: the nesting rule of its level before its fields (serialize-depth).
                if (count($open) + 1 > self::DEPTH) {
                    throw self::serializeRule(self::DEPTH_RULE);
                }
                self::serializedDelimiter($text, $at, ':');
                $members = self::serializedLength(self::serializedField($text, $at, ':'), 'array');
                self::serializedDelimiter($text, $at, '{');
                if ($members > 0) {
                    $open[] = [[], $members, false, 0];
                    continue;
                }
                self::serializedDelimiter($text, $at, '}');
                $value = [];
            } else {
                $value = self::serializedScalar($text, $at, $type);
            }
            while (true) {
                if ($open === []) {
                    if ($at !== $length) {
                        throw self::serializeRule('trailing data');
                    }
                    return $value;
                }
                $top = count($open) - 1;
                if (!$open[$top][2]) {
                    if (!is_int($value) && !is_string($value)) {
                        throw self::serializeRule('array key must be int or string');
                    }
                    // A PHP array key is an integer by its decimal string, so that i:1; and s:1:"1"; are one key and
                    // i:1; and s:2:"01"; are two; the key that repeats one is met before its value
                    // (serialize-duplicate).
                    if (array_key_exists($value, $open[$top][0])) {
                        throw self::serializeRule('duplicate array key');
                    }
                    $open[$top][2] = true;
                    $open[$top][3] = $value;
                    continue 2;
                }
                $open[$top][0][$open[$top][3]] = $value;
                $open[$top][2] = false;
                if (--$open[$top][1] > 0) {
                    continue 2;
                }
                self::serializedDelimiter($text, $at, '}');
                $value = array_pop($open)[0];
            }
        }
    }

    /** A value of the type letter $type other than an array, read from $at. */
    private static function serializedScalar(string $text, int &$at, string $type): null|bool|int|float|string
    {
        switch ($type) {
            case 'N':
                self::serializedDelimiter($text, $at, ';');
                return null;
            case 'b':
                self::serializedDelimiter($text, $at, ':');
                $field = self::serializedField($text, $at, ';');
                if ($field !== '0' && $field !== '1') {
                    throw self::serializeRule('bad bool');
                }
                return $field === '1';
            case 'i':
                self::serializedDelimiter($text, $at, ':');
                return self::serializedInt(self::serializedField($text, $at, ';'));
            case 'd':
                self::serializedDelimiter($text, $at, ':');
                return self::serializedFloat(self::serializedField($text, $at, ';'));
            case 's':
                self::serializedDelimiter($text, $at, ':');
                $size = self::serializedLength(self::serializedField($text, $at, ':'), 'string');
                self::serializedDelimiter($text, $at, '"');
                if ($size > strlen($text) - $at) {
                    throw self::serializeRule('string overruns input');
                }
                $value = substr($text, $at, $size);
                $at += $size;
                if (!mb_check_encoding($value, 'UTF-8')) {
                    throw self::serializeRule('string is not valid UTF-8');
                }
                self::serializedDelimiter($text, $at, '"');
                self::serializedDelimiter($text, $at, ';');
                return $value;
            case 'O':
            case 'C':
            case 'r':
            case 'R':
                throw new OrmException(Code::CODEC_UNSUPPORTED, 'serialize: objects and references are not supported');
            default:
                throw self::serializeRule('unknown type');
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

    /** Refuses a host style list with a style other than aes, hex and ip before the value or the cell is read. */
    private static function checkHostStyles(array $styles): void
    {
        foreach ($styles as $st) {
            if (!self::isHostStyle($st)) {
                throw new OrmException(Code::CODEC_UNSUPPORTED, "host style $st");
            }
        }
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
        self::checkHostStyles($styles);
        if ($v === null) {
            return null;
        }
        $cur = self::plainBytes($v, 'host');
        foreach ($styles as $st) {
            $cur = match ($st) {
                'aes' => self::aesSeal($cur, $aesKey),
                'hex' => strtoupper(bin2hex($cur)),
                'ip' => self::packIp($cur),
            };
        }
        return $styles[count($styles) - 1] === 'hex' ? $cur : new Bytes($cur);
    }

    /** The ORM-AES2 envelope of the bytes: the prefix, a random 12-byte nonce, the AES-256-GCM ciphertext and its tag. */
    private static function aesSeal(string $plain, string $aesKey): string
    {
        if ($aesKey === '') {
            throw new OrmException(Code::CONFIG, 'secret aes not configured');
        }
        try {
            $nonce = random_bytes(12);
        } catch (\Throwable $e) {
            throw new OrmException(Code::CODEC_ENCODE, 'aes: the encryption failed', $e);
        }
        $tag = '';
        self::opensslClear();
        try {
            $encrypted = openssl_encrypt(
                $plain,
                'aes-256-gcm',
                self::aesV2Key($aesKey),
                OPENSSL_RAW_DATA,
                $nonce,
                $tag,
                "ORM-AES2\0",
                16
            );
        } catch (\Throwable $e) {
            throw new OrmException(Code::CODEC_ENCODE, 'aes: the encryption failed', $e);
        }
        if ($encrypted === false) {
            $cause = self::opensslFailure('openssl_encrypt');
            throw new OrmException(Code::CODEC_ENCODE, 'aes: the encryption failed', $cause);
        }
        return "ORM-AES2\0" . $nonce . $encrypted . $tag;
    }

    /** Undoes hostEncode on a read cell (styles in write order, applied in reverse). @param list<string> $styles */
    public static function hostDecode(mixed $raw, array $styles, string $aesKey): ?string
    {
        self::checkHostStyles($styles);
        if (is_resource($raw)) {
            $raw = stream_get_contents($raw);
        }
        if ($raw instanceof Bytes) {
            $raw = $raw->bytes;
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
                    if (strlen($cur) % 2 !== 0 || strspn($cur, '0123456789ABCDEF') !== strlen($cur)) {
                        throw new OrmException(Code::CODEC_DECODE, 'hex: odd length or non-hex input');
                    }
                    $cur = hex2bin($cur);
                    break;
                case 'aes':
                    $cur = self::aesOpen($cur, $aesKey);
                    break;
                default:
                    // ip, the last kind of host style: its text ends the decode.
                    return self::unpackIp($cur);
            }
        }
        return $cur;
    }

    /** The plaintext of an ORM-AES2 envelope that the key authenticates. */
    private static function aesOpen(string $cur, string $aesKey): string
    {
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
        self::opensslClear();
        try {
            $plain = openssl_decrypt(
                substr($cur, $offset + 12, -16),
                'aes-256-gcm',
                self::aesV2Key($aesKey),
                OPENSSL_RAW_DATA,
                substr($cur, $offset, 12),
                substr($cur, -16),
                $prefix
            );
        } catch (\Throwable $e) {
            throw new OrmException(Code::CODEC_DECODE, 'aes: authentication failed', $e);
        }
        if ($plain === false) {
            $cause = self::opensslFailure('openssl_decrypt');
            throw new OrmException(Code::CODEC_DECODE, 'aes: authentication failed', $cause);
        }
        return $plain;
    }

    /** INET6_ATON: 4 bytes for IPv4 and 16 for IPv6, an IPv4-mapped address included (COD-38). */
    private static function packIp(string $s): string
    {
        // The exact text only: white space around the address is CODEC_ENCODE (docs/spec/codec.md).
        // inet_pton throws a ValueError on a NUL byte, which is not an address either, and accepts a zone (%eth0),
        // which is no part of one (COD-38).
        if (str_contains($s, "\0") || str_contains($s, '%')) {
            throw new OrmException(Code::CODEC_ENCODE, 'ip: the text is not an address');
        }
        [$b, $cause] = self::libraryCall('inet_pton', static fn (): string|false => inet_pton($s));
        if ($cause !== null) {
            throw new OrmException(Code::CODEC_ENCODE, 'ip: the text is not an address', $cause);
        }
        return $b;
    }

    /** INET6_NTOA: the RFC 5952 text, an IPv4-mapped address as ::ffff:a.b.c.d (section 5). */
    private static function unpackIp(string $b): string
    {
        $n = strlen($b);
        if ($n !== 4 && $n !== 16) {
            throw new OrmException(Code::CODEC_DECODE, 'ip: the cell is not 4 or 16 packed bytes');
        }
        // inet_ntop writes the text of any 4 or 16 bytes (COD-72).
        return inet_ntop($b);
    }

    /**
     * Decodes the styled cells of positional rows in place: the host stages first, then the codec
     * stages. $cells is a step's 'decode' list from Assemble::index (joined columns included):
     * [index, host stages, codec stages, whether the host stages include aes, the index of the
     * node's aes_key_version column or null, the <entity>.<column> of the cell, the <entity>.<column> of
     * the version column or null]. A CODEC_DECODE of a cell names its entity and column, and one of a
     * stored version names the version column: "CODEC_DECODE: <entity>.<column>: <message>" (COD-41).
     * @param list<list<mixed>> $rows
     * @param list<array{0: int, 1: list<string>, 2: list<string>, 3: bool, 4: ?int, 5: string, 6: ?string}> $cells
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
            foreach ($cells as [$index, $host, $codec, $aes, $versionIndex, $name, $versionName]) {
                $v = $vals[$index];
                if ($host !== []) {
                    if ($aes && ($versionIndex === null || $versionName === null)) {
                        // The planner selects the version column of every AES column, so a plan without one is broken:
                        // no version is assumed.
                        throw new OrmException(Code::INTERNAL, 'an AES column has no version column');
                    }
                    // The version is read only for a non-NULL value: a NULL cell with a NULL version stays NULL
                    // (COD-44).
                    if ($v !== null) {
                        $key = !$aes
                            ? $config->aesKey
                            : $keyring->key(self::rowVersion($vals, $versionIndex, $versionName));
                        try {
                            $v = self::hostDecode($v, $host, $key);
                        } catch (OrmException $e) {
                            throw self::namedDecodeFailure($e, $name);
                        }
                    }
                }
                if ($codec !== []) {
                    try {
                        $v = self::decode($codec, $v);
                    } catch (OrmException $e) {
                        throw self::namedDecodeFailure($e, $name);
                    }
                } elseif (is_resource($v)) {
                    $v = stream_get_contents($v);
                }
                $vals[$index] = $v;
            }
        }
    }

    /** A CODEC_DECODE of a read cell with its <entity>.<column> before its message (COD-41); another code is kept. */
    private static function namedDecodeFailure(OrmException $e, string $name): OrmException
    {
        if ($e->code_ !== Code::CODEC_DECODE) {
            return $e;
        }
        return new OrmException(
            Code::CODEC_DECODE,
            $name . ': ' . substr($e->getMessage(), strlen(Code::CODEC_DECODE . ': ')),
            $e
        );
    }

    /**
     * The key version of a read row's version cell (COD-44): a missing cell is INTERNAL, a stored version that is not a
     * positive 32-bit integer is the CODEC_DECODE of the version cell, which names its <entity>.<column> (COD-41).
     * @param array<array-key, mixed> $vals
     */
    private static function rowVersion(array $vals, int $index, string $name): int
    {
        if (!array_key_exists($index, $vals)) {
            throw new OrmException(Code::INTERNAL, "the AES version cell $index is missing from the row");
        }
        try {
            return AesKeyring::storedVersion($vals[$index]);
        } catch (OrmException $e) {
            throw self::namedDecodeFailure($e, $name);
        }
    }
}
