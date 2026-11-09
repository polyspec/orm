<?php

declare(strict_types=1);

namespace Polyspec\Orm;

use Polyspec\OrderedJson\ParseError;
use Polyspec\OrderedJson\Value;
use Purr\Yaml\Document;
use Purr\Yaml\Dumper\Dumper;
use Purr\Yaml\Node\AbstractNode;
use Purr\Yaml\Node\CollectionStyle;
use Purr\Yaml\Node\MappingEntry;
use Purr\Yaml\Node\MappingEntryList;
use Purr\Yaml\Node\MappingNode;
use Purr\Yaml\Node\NodeList;
use Purr\Yaml\Node\ScalarNode;
use Purr\Yaml\Node\ScalarStyle;
use Purr\Yaml\Node\SequenceNode;

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

    /**
     * Where a block node starts (s-l+block-node): on the next lines, after `-`, `?` or the `:` of an explicit entry,
     * after the `:` of an implicit key, or after `---`.
     */
    private const int Y_AT_LINES = 0;
    private const int Y_AT_INDICATOR = 1;
    private const int Y_AT_COLON = 2;
    private const int Y_AT_DOCUMENT = 3;

    /**
     * The frames of the YAML reader: the open collections, the pair of a flow sequence, and the rest of the line after
     * a flow node of a block collection.
     */
    private const int Y_BLOCK_SEQUENCE = 1;
    private const int Y_BLOCK_MAPPING = 2;
    private const int Y_FLOW_SEQUENCE = 3;
    private const int Y_FLOW_MAPPING = 4;
    private const int Y_PAIR = 5;
    private const int Y_TRAIL = 6;

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
     * The place after the string literal of a JSON text whose opening quote stands at $i: after its closing quote, a
     * backslash escaping the byte after it, or the end of the text.
     */
    private static function jsonStringEnd(string $text, int $i): int
    {
        $length = strlen($text);
        for ($i++; $i < $length; $i++) {
            if ($text[$i] === '\\') {
                $i++;
            } elseif ($text[$i] === '"') {
                return $i + 1;
            }
        }
        return $length;
    }

    /**
     * The stored text of a JSON text: the insignificant whitespace outside the string literals is removed, and every
     * other byte, the member order and the repeated member names included, stays in place (DIA-26).
     */
    private static function compactJsonText(string $text): string
    {
        $out = '';
        $length = strlen($text);
        for ($i = 0; $i < $length; $i++) {
            $c = $text[$i];
            if ($c === '"') {
                $after = self::jsonStringEnd($text, $i);
                $out .= substr($text, $i, $after - $i);
                $i = $after - 1;
            } elseif ($c !== ' ' && $c !== "\t" && $c !== "\n" && $c !== "\r") {
                $out .= $c;
            }
        }
        return $out;
    }

    /** The deepest nesting of arrays and objects in a JSON text, its string literals aside. */
    private static function jsonTextDepth(string $text): int
    {
        $depth = 0;
        $deepest = 0;
        $length = strlen($text);
        for ($i = 0; $i < $length; $i++) {
            $c = $text[$i];
            if ($c === '"') {
                $i = self::jsonStringEnd($text, $i) - 1;
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
     * Reads one YAML document with the YAML reader of orm (docs/spec/codec.md COD-74 to COD-80): the stream rules
     * first, then the stream by the grammar of YAML 1.2.2 in one pass, in its order, with the rules of COD-70 met where
     * their node starts. No library parses on this path; a stream that the grammar does not hold is yaml-parse, whose
     * cause names the line and the column where the stream leaves the grammar (COD-71, COD-80).
     */
    private static function yamlDecode(string $text): mixed
    {
        self::yamlStream($text);
        $stream = str_starts_with($text, "\u{FEFF}") ? substr($text, 3) : $text;
        // A line break is CR LF, CR or LF, and each is one LF inside scalar content (COD-75); the lines and the
        // columns of the text are those of the stream.
        $r = new \stdClass();
        $r->s = str_replace(["\r\n", "\r"], "\n", $stream);
        $r->end = strlen($r->s);
        $r->trunc = false;
        $r->p = 0;
        $r->level = 0;
        return self::yamlDocuments($r);
    }

    /**
     * The stream rules of YAML 1.2 that hold before the reader reads the stream (COD-66, COD-75): the stream is UTF-8,
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
     * yaml-parse at the byte $at of the stream: its cause is the error of the reader, which names the line and the
     * column of that place, each from 1, the column in Unicode characters (COD-80).
     */
    private static function yamlParseError(\stdClass $r, int $at): never
    {
        $at = min($at, strlen($r->s));
        $line = substr_count($r->s, "\n", 0, $at) + 1;
        $break = $at === 0 ? false : strrpos($r->s, "\n", $at - strlen($r->s) - 1);
        $start = $break === false ? 0 : $break + 1;
        $bytes = substr($r->s, $start, $at - $start);
        $column = strlen($bytes) - preg_match_all('/[\x80-\xBF]/', $bytes) + 1;
        throw new OrmException(
            Code::CODEC_DECODE,
            'yaml: the stream does not parse',
            new \RuntimeException("the stream leaves the YAML grammar at line $line, column $column")
        );
    }

    /** The character at $p, or '' at the end of what the reader reads. */
    private static function yamlAt(\stdClass $r, int $p): string
    {
        return $p < $r->end ? $r->s[$p] : '';
    }

    /** Whether $c is white space, a line break or the end, which an indicator is followed by (s-white, b-break). */
    private static function yamlSep(string $c): bool
    {
        return $c === '' || $c === ' ' || $c === "\t" || $c === "\n";
    }

    /** Whether $c is a flow indicator (c-flow-indicator [23]). */
    private static function yamlFlowIndicator(string $c): bool
    {
        return $c === ',' || $c === '[' || $c === ']' || $c === '{' || $c === '}';
    }

    /**
     * Whether $c is ns-plain-safe [127] to [129]: outside a flow collection any ns-char, inside none of the flow
     * indicators.
     */
    private static function yamlSafe(string $c, bool $in): bool
    {
        return !self::yamlSep($c) && !($in && self::yamlFlowIndicator($c));
    }

    /** Whether a plain scalar starts at $p (ns-plain-first [126]). */
    private static function yamlPlainFirst(\stdClass $r, int $p, bool $in): bool
    {
        $c = self::yamlAt($r, $p);
        if (self::yamlSep($c)) {
            return false;
        }
        if ($c === '-' || $c === '?' || $c === ':') {
            return self::yamlSafe(self::yamlAt($r, $p + 1), $in);
        }
        return strpbrk($c, "-?:,[]{}#&*!|>'\"%@`") === false;
    }

    /** The number of bytes of the UTF-8 character whose first byte is $c. */
    private static function yamlCharLength(string $c): int
    {
        $b = ord($c);
        return $b < 0x80 ? 1 : ($b < 0xE0 ? 2 : ($b < 0xF0 ? 3 : 4));
    }

    /** The place of the line break that ends the line of $p, or the end. */
    private static function yamlLineStop(\stdClass $r, int $p): int
    {
        $q = strpos($r->s, "\n", min($p, $r->end));
        return $q === false || $q > $r->end ? $r->end : $q;
    }

    /**
     * Whether a node of one line, as an implicit key is, ends at $p of the stream: at the end of the stream, at the
     * line break, or at a comment after white space.
     */
    private static function yamlLineEnds(\stdClass $r, int $p): bool
    {
        $c = $p < strlen($r->s) ? $r->s[$p] : '';
        return $c === '' || $c === "\n" || ($c === '#' && $p > 0 && ($r->s[$p - 1] === ' ' || $r->s[$p - 1] === "\t"));
    }

    /** The marker `---` or `...` that starts a line at $p (c-forbidden [206]), or ''. */
    private static function yamlMarker(\stdClass $r, int $p): string
    {
        $mark = substr($r->s, $p, 3);
        if (($mark === '---' || $mark === '...') && $p + 3 <= $r->end && self::yamlSep(self::yamlAt($r, $p + 3))) {
            return $mark;
        }
        return '';
    }

    /**
     * Moves from the start of a line past the empty lines and the comment lines (s-l-comments [79]) to the start of the
     * next line that holds content, and returns the number of spaces that indent it, or -1 at the end.
     */
    private static function yamlNextLine(\stdClass $r): int
    {
        $s = $r->s;
        $end = $r->end;
        $p = $r->p;
        while ($p < $end) {
            $q = $p;
            while ($q < $end && $s[$q] === ' ') {
                $q++;
            }
            $indent = $q - $p;
            while ($q < $end && ($s[$q] === ' ' || $s[$q] === "\t")) {
                $q++;
            }
            if ($q < $end && $s[$q] === '#') {
                $q = self::yamlLineStop($r, $q);
            }
            if ($q >= $end) {
                break;
            }
            if ($s[$q] === "\n") {
                $p = $q + 1;
                continue;
            }
            $r->p = $p;
            return $indent;
        }
        $r->p = $end;
        return -1;
    }

    /** Whether $c is one ASCII hexadecimal digit (YAML 1.2.2 [35] ns-hex-digit); ctype_xdigit follows the locale. */
    private static function yamlHexDigit(string $c): bool
    {
        return strlen($c) === 1 && strspn($c, '0123456789abcdefABCDEF') === 1;
    }

    /**
     * Whether $c is one ASCII letter or digit, of [38] ns-word-char with the "-" apart; ctype_alnum follows the locale.
     */
    private static function yamlWordChar(string $c): bool
    {
        return strlen($c) === 1 && strspn($c, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') === 1;
    }

    /**
     * The rest of a line after a node or a marker (s-l-comments [79]): white space, a comment after white space, and
     * the line break or the end; the reader then stands at the start of the next line.
     */
    private static function yamlLineEnd(\stdClass $r): void
    {
        $s = $r->s;
        $end = $r->end;
        $p = $r->p;
        $p = self::yamlLineComment($r, $p, $p === 0 || $s[$p - 1] === "\n");
        if ($p < $end && $s[$p] !== "\n") {
            self::yamlParseError($r, $p);
        }
        $r->p = $p < $end ? $p + 1 : $p;
    }

    /**
     * The white space from $p and a comment after it (s-separate-in-line [66], c-nb-comment-text [75]); $white is
     * whether white space or the start of a line stands before $p, and a comment after no white space is yaml-parse.
     * Returns the place after them.
     */
    private static function yamlLineComment(\stdClass $r, int $p, bool $white): int
    {
        $s = $r->s;
        $end = $r->end;
        while ($p < $end && ($s[$p] === ' ' || $s[$p] === "\t")) {
            $p++;
            $white = true;
        }
        if ($p < $end && $s[$p] === '#') {
            if (!$white) {
                self::yamlParseError($r, $p);
            }
            $p = self::yamlLineStop($r, $p);
        }
        return $p;
    }

    /**
     * The separation between the tokens of a flow collection (s-separate [80]): white space, comments after white
     * space and line breaks; each line after the first that holds a token is indented by at least $need spaces
     * (s-flow-line-prefix [69]), and a marker starts none of them.
     */
    private static function yamlFlowSpace(\stdClass $r, int $need): void
    {
        $s = $r->s;
        $end = $r->end;
        $p = $r->p;
        while (true) {
            $p = self::yamlLineComment($r, $p, false);
            if ($p >= $end || $s[$p] !== "\n") {
                break;
            }
            $p++;
            while (true) {
                if ($p >= $end) {
                    break 2;
                }
                if (self::yamlMarker($r, $p) !== '') {
                    self::yamlParseError($r, $p);
                }
                $q = $p;
                while ($q < $end && $s[$q] === ' ') {
                    $q++;
                }
                $t = $q;
                while ($t < $end && ($s[$t] === ' ' || $s[$t] === "\t")) {
                    $t++;
                }
                if ($t < $end && $s[$t] === '#') {
                    $t = self::yamlLineStop($r, $t);
                }
                if ($t >= $end) {
                    $p = $t;
                    break 2;
                }
                if ($s[$t] === "\n") {
                    $p = $t + 1;
                    continue;
                }
                if ($q - $p < $need) {
                    self::yamlParseError($r, $t);
                }
                $p = $t;
                break 2;
            }
        }
        $r->p = $p;
    }

    /**
     * The lines after a line break inside a scalar that folds, a quoted or a plain one (b-l-folded [74], l-empty
     * [70]): the empty lines, which it counts, then the white space before the next text, whose line is indented by
     * at least $need spaces and is no marker. Returns the place of that text, or the place where the scalar leaves
     * the grammar as -1 - $place.
     */
    private static function yamlFoldedLines(\stdClass $r, int $p, int $need, int &$breaks): int
    {
        $s = $r->s;
        $end = $r->end;
        $breaks = 0;
        while (true) {
            if ($p >= $end || self::yamlMarker($r, $p) !== '') {
                return -1 - $p;
            }
            $a = $p;
            while ($a < $end && $s[$a] === ' ') {
                $a++;
            }
            $b = $a;
            while ($b < $end && ($s[$b] === ' ' || $s[$b] === "\t")) {
                $b++;
            }
            if ($b < $end && $s[$b] === "\n") {
                if ($b > $a && $a - $p < $need) {
                    return -1 - $a;
                }
                $breaks++;
                $p = $b + 1;
                continue;
            }
            if ($b >= $end || $a - $p < $need) {
                return -1 - $b;
            }
            return $b;
        }
    }

    /**
     * The white space and the line break at $q of a quoted scalar, which fold (6.5): white space before more text is
     * content, and a line break is a space or the empty lines after it; an implicit key is one line. Returns the place
     * after them, or the place where the scalar leaves the grammar as -1 - $place.
     */
    private static function yamlQuotedWhite(\stdClass $r, int $q, bool $multi, int $need, string &$text): int
    {
        $s = $r->s;
        $end = $r->end;
        $w = $q;
        while ($w < $end && ($s[$w] === ' ' || $s[$w] === "\t")) {
            $w++;
        }
        if ($w >= $end || $s[$w] !== "\n") {
            $text .= substr($s, $q, $w - $q);
            return $w;
        }
        if (!$multi) {
            return -1 - $w;
        }
        $breaks = 0;
        $next = self::yamlFoldedLines($r, $w + 1, $need, $breaks);
        if ($next < 0) {
            return $next;
        }
        $text .= $breaks === 0 ? ' ' : str_repeat("\n", $breaks);
        return $next;
    }

    /**
     * The escape at the backslash at $q of a double-quoted scalar (5.7): a character of its own, a code point of
     * \x, \u or \U, or an escaped line break, which joins the lines; an implicit key is one line. Returns the place
     * after it, or the place where the scalar leaves the grammar as -1 - $place.
     */
    private static function yamlDoubleEscape(\stdClass $r, int $q, bool $multi, int $need, string &$text): int
    {
        static $escapes = [
            '0' => "\0", 'a' => "\x07", 'b' => "\x08", 't' => "\t", "\t" => "\t", 'n' => "\n", 'v' => "\x0B",
            'f' => "\x0C", 'r' => "\r", 'e' => "\x1B", ' ' => ' ', '"' => '"', '/' => '/', '\\' => '\\',
            'N' => "\u{85}", '_' => "\u{A0}", 'L' => "\u{2028}", 'P' => "\u{2029}",
        ];
        $s = $r->s;
        $end = $r->end;
        $e = self::yamlAt($r, $q + 1);
        if (isset($escapes[$e])) {
            $text .= $escapes[$e];
            return $q + 2;
        }
        if ($e === 'x' || $e === 'u' || $e === 'U') {
            $digits = $e === 'x' ? 2 : ($e === 'u' ? 4 : 8);
            for ($i = $q + 2; $i < $q + 2 + $digits; $i++) {
                if ($i >= $end || !self::yamlHexDigit($s[$i])) {
                    return -1 - $i;
                }
            }
            $code = hexdec(substr($s, $q + 2, $digits));
            // A surrogate and a number above U+10FFFF are no Unicode scalar value (COD-78).
            if (($code >= 0xD800 && $code <= 0xDFFF) || $code > 0x10FFFF) {
                return -1 - $q;
            }
            $text .= mb_chr((int) $code, 'UTF-8');
            return $q + 2 + $digits;
        }
        if ($e === "\n" && $multi) {
            // An escaped line break joins the lines and keeps the white space before it (s-double-escaped).
            $breaks = 0;
            $next = self::yamlFoldedLines($r, $q + 2, $need, $breaks);
            if ($next < 0) {
                return $next;
            }
            $text .= str_repeat("\n", $breaks);
            return $next;
        }
        return -1 - ($q + 1);
    }

    /**
     * A quoted scalar from its quote at $p, with the folding of 6.5: a double-quoted one ([107] to [116]) with the
     * escapes of 5.7, or a single-quoted one ([117] to [125]), whose one escape is ''; an implicit key is one line.
     * Returns -1 with $p after the closing quote, or the place where the scalar leaves the grammar.
     */
    private static function yamlQuoted(\stdClass $r, int &$p, bool $multi, int $need, string &$text): int
    {
        $s = $r->s;
        $end = $r->end;
        $quote = $s[$p];
        $stops = $quote === '"' ? "\"\\ \t\n" : "' \t\n";
        $q = $p + 1;
        $text = '';
        while (true) {
            if ($q >= $end) {
                return $q;
            }
            $c = $s[$q];
            if ($c === $quote) {
                if ($quote === "'" && self::yamlAt($r, $q + 1) === "'") {
                    $text .= "'";
                    $q += 2;
                    continue;
                }
                $p = $q + 1;
                return -1;
            }
            if ($c === '\\' && $quote === '"') {
                $q = self::yamlDoubleEscape($r, $q, $multi, $need, $text);
            } elseif ($c === ' ' || $c === "\t" || $c === "\n") {
                $q = self::yamlQuotedWhite($r, $q, $multi, $need, $text);
            } else {
                $run = strcspn($s, $stops, $q, $end - $q);
                $text .= substr($s, $q, $run);
                $q += $run;
                continue;
            }
            if ($q < 0) {
                return -1 - $q;
            }
        }
    }

    /**
     * A plain scalar from $p, whose first character is ns-plain-first ([126] to [135]): it holds no `: ` and no ` #`,
     * inside a flow collection ($in) no flow indicator, and, unless it is an implicit key, continues on the next lines
     * indented by at least $need spaces, which fold (6.5). Returns -1 with $p after its last character. In the read of
     * a node that is no key (COD-80), a scalar that the reader cannot know to end before the place where the key leaves
     * the grammar is not read whole, and that place is returned; a place where a node of one line ends, the end of its
     * line or a comment, ends the scalar, which is then read whole.
     */
    private static function yamlPlain(\stdClass $r, int &$p, bool $in, bool $multi, int $need, string &$text): int
    {
        $s = $r->s;
        $end = $r->end;
        $q = $p;
        $text = '';
        $reached = false;
        while (true) {
            $start = $q;
            $q++;
            while (true) {
                if ($q >= $end) {
                    $reached = true;
                    break;
                }
                $c = $s[$q];
                if ($c === ' ' || $c === "\t") {
                    $w = $q + 1;
                    while ($w < $end && ($s[$w] === ' ' || $s[$w] === "\t")) {
                        $w++;
                    }
                    if ($w >= $end) {
                        $reached = true;
                        break;
                    }
                    $d = $s[$w];
                    if ($d === "\n" || $d === '#' || ($in && self::yamlFlowIndicator($d))) {
                        break;
                    }
                    if ($d === ':') {
                        if ($w + 1 >= $end) {
                            $reached = true;
                        }
                        if (!self::yamlSafe(self::yamlAt($r, $w + 1), $in)) {
                            break;
                        }
                    }
                    $q = $w;
                    continue;
                }
                if ($c === "\n" || ($in && self::yamlFlowIndicator($c))) {
                    break;
                }
                if ($c === ':') {
                    if ($q + 1 >= $end) {
                        $reached = true;
                    }
                    if (!self::yamlSafe(self::yamlAt($r, $q + 1), $in)) {
                        break;
                    }
                }
                $q++;
            }
            $text .= substr($s, $start, $q - $start);
            if (!$multi || $reached) {
                break;
            }
            $w = $q;
            while ($w < $end && ($s[$w] === ' ' || $s[$w] === "\t")) {
                $w++;
            }
            if ($w >= $end || $s[$w] !== "\n") {
                break;
            }
            $breaks = 0;
            $next = -1;
            $b = self::yamlFoldedLines($r, $w + 1, $need, $breaks);
            if ($b >= 0) {
                $d = $s[$b];
                $colon = $d === ':' && !self::yamlSafe(self::yamlAt($r, $b + 1), $in);
                if ($d !== '#' && !$colon && !($in && self::yamlFlowIndicator($d))) {
                    $next = $b;
                }
            }
            if ($next < 0) {
                break;
            }
            $text .= $breaks === 0 ? ' ' : str_repeat("\n", $breaks);
            $q = $next;
        }
        if ($reached && $r->trunc && !self::yamlLineEnds($r, $end)) {
            return $end;
        }
        $p = $q;
        return -1;
    }

    /**
     * A block scalar from its indicator at $p ([162] to [182]) inside a block collection indented by $n spaces (-1 for
     * the node of a document): its header, its content lines by the content indentation of 8.1.1.1, the folding of
     * a folded scalar and the chomping of 8.1.1.2. The reader then stands at the start of the line that ends it.
     */
    private static function yamlBlockScalar(\stdClass $r, int $n): string
    {
        $s = $r->s;
        $end = $r->end;
        $p = $r->p;
        $folded = $s[$p] === '>';
        $p++;
        $indicator = 0;
        $chomp = '';
        for ($i = 0; $i < 2; $i++) {
            $c = self::yamlAt($r, $p);
            if ($indicator === 0 && $c >= '1' && $c <= '9' && strlen($c) === 1) {
                $indicator = (int) $c;
                $p++;
            } elseif ($chomp === '' && ($c === '-' || $c === '+')) {
                $chomp = $c;
                $p++;
            }
        }
        $p = self::yamlLineComment($r, $p, false);
        if ($p < $end && $s[$p] !== "\n") {
            self::yamlParseError($r, $p);
        }
        $p = $p < $end ? $p + 1 : $p;
        // The content indentation: the indicator, or the spaces of the first line that is not empty (8.1.1.1).
        if ($indicator > 0) {
            $indent = $n + $indicator;
        } else {
            $indent = -1;
            $longest = 0;
            $q = $p;
            while ($q < $end) {
                $a = $q;
                while ($a < $end && $s[$a] === ' ') {
                    $a++;
                }
                if ($a < $end && $s[$a] === "\n") {
                    $longest = max($longest, $a - $q);
                    $q = $a + 1;
                    continue;
                }
                if ($a < $end && $a - $q > $n && !($a === $q && self::yamlMarker($r, $q) !== '')) {
                    $indent = $a - $q;
                    if ($longest > $indent) {
                        self::yamlParseError($r, $a);
                    }
                }
                break;
            }
            if ($indent < 0) {
                $indent = max($longest, $n + 1);
            }
        }
        $lines = [];
        $final = false;
        while ($p < $end) {
            if (self::yamlMarker($r, $p) !== '') {
                break;
            }
            $a = $p;
            while ($a < $end && $s[$a] === ' ') {
                $a++;
            }
            $spaces = $a - $p;
            if ($a < $end && $s[$a] === "\n") {
                if ($spaces > $indent) {
                    $lines[] = str_repeat(' ', $spaces - $indent);
                    $final = true;
                } else {
                    $lines[] = null;
                }
                $p = $a + 1;
                continue;
            }
            if ($a >= $end) {
                if ($spaces > $indent) {
                    $lines[] = str_repeat(' ', $spaces - $indent);
                    $final = false;
                    $p = $a;
                }
                break;
            }
            if ($spaces < $indent) {
                break;
            }
            $stop = self::yamlLineStop($r, $a);
            $lines[] = substr($s, $p + $indent, $stop - $p - $indent);
            $final = $stop < $end;
            $p = $final ? $stop + 1 : $stop;
        }
        $r->p = $p;
        $last = -1;
        foreach ($lines as $i => $line) {
            if ($line !== null) {
                $last = $i;
            }
        }
        $trailing = count($lines) - $last - 1;
        if ($last < 0) {
            return $chomp === '+' ? str_repeat("\n", $trailing) : '';
        }
        $body = '';
        if ($folded) {
            $empty = 0;
            $previous = null;
            for ($i = 0; $i <= $last; $i++) {
                $line = $lines[$i];
                if ($line === null) {
                    $empty++;
                    continue;
                }
                $spaced = $line !== '' && ($line[0] === ' ' || $line[0] === "\t");
                if ($previous === null) {
                    $body .= str_repeat("\n", $empty);
                } elseif (!$previous && !$spaced) {
                    $body .= $empty === 0 ? ' ' : str_repeat("\n", $empty);
                } else {
                    $body .= str_repeat("\n", $empty + 1);
                }
                $body .= $line;
                $previous = $spaced;
                $empty = 0;
            }
        } else {
            $kept = array_slice($lines, 0, $last + 1);
            $body = implode("\n", array_map(static fn (?string $line): string => $line ?? '', $kept));
        }
        if ($chomp === '-') {
            return $body;
        }
        $body .= $final ? "\n" : '';
        return $chomp === '+' ? $body . str_repeat("\n", $trailing) : $body;
    }

    /**
     * A plain scalar by the core schema (10.3.2, COD-79): a value, or, as a map key, its string, an integer by its
     * decimal text; the rules of its content are met here, once it is read whole (COD-80).
     */
    private static function yamlResolve(string $text, bool $key): mixed
    {
        if ($text === '' || $text === '~' || $text === 'null' || $text === 'Null' || $text === 'NULL') {
            return $key ? throw self::yamlRule('map keys must be strings or integers') : null;
        }
        if (in_array($text, ['true', 'True', 'TRUE', 'false', 'False', 'FALSE'], true)) {
            if ($key) {
                throw self::yamlRule('map keys must be strings or integers');
            }
            return $text[0] === 't' || $text[0] === 'T';
        }
        if (preg_match('/\A([-+]?)0*([0-9]+)\z/', $text, $m) === 1) {
            $limit = $m[1] === '-' ? '9223372036854775808' : '9223372036854775807';
            if (strlen($m[2]) > 19 || (strlen($m[2]) === 19 && strcmp($m[2], $limit) > 0)) {
                throw self::yamlRule('integer is outside the i64 range');
            }
            return (int) ($m[1] === '-' ? "-$m[2]" : $m[2]);
        }
        $octal = preg_match('/\A0o0*([0-7]+)\z/', $text, $m) === 1;
        if ($octal || preg_match('/\A0x0*([0-9a-fA-F]+)\z/', $text, $m) === 1) {
            $hex = $text[1] === 'x';
            // 2^63 - 1 is 21 octal digits and 7fffffffffffffff.
            $digits = $m[1];
            if ($hex ? strlen($digits) > 16 || (strlen($digits) === 16 && $digits[0] > '7') : strlen($digits) > 21) {
                throw self::yamlRule('integer is outside the i64 range');
            }
            $value = 0;
            foreach (str_split($digits) as $d) {
                $value = $value * ($hex ? 16 : 8) + (int) hexdec($d);
            }
            return $value;
        }
        $float = preg_match('/\A[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?\z/', $text) === 1;
        $infinite = preg_match('/\A([-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))\z/', $text) === 1;
        if ($float || $infinite) {
            if ($key) {
                throw self::yamlRule('map keys must be strings or integers');
            }
            // The binary64 nearest to the decimal text; one that rounds to an infinity is not finite (COD-79).
            $value = $float ? (float) $text : INF;
            if (!is_finite($value)) {
                throw self::yamlRule('number is not finite');
            }
            return $value;
        }
        return $text;
    }

    /** Opens a collection at the level after the open ones: its nesting rule, then, for a key, yaml-key-collection. */
    private static function yamlOpen(\stdClass $r, bool $key): void
    {
        if ($r->level >= self::DEPTH) {
            throw self::yamlRule(self::DEPTH_RULE);
        }
        if ($key) {
            throw self::yamlRule('map keys must be scalar strings');
        }
        $r->level++;
    }

    /** A frame of the reader: a collection that is open, or the rest of the line after a flow node of a block. */
    private static function yamlFrame(int $type, int $state, int $indent): \stdClass
    {
        $f = new \stdClass();
        $f->t = $type;
        $f->st = $state;
        $f->m = $indent;
        $f->v = [];
        $f->k = null;
        $f->j = false;
        $f->f = 0;
        $f->known = false;
        return $f;
    }

    /** Records the key of a map entry, met where it repeats an earlier one (yaml-duplicate). */
    private static function yamlKey(\stdClass $f, int|string $key, bool $json): void
    {
        if (array_key_exists($key, $f->v)) {
            throw self::yamlRule('duplicate map key');
        }
        $f->k = $key;
        $f->j = $json;
    }

    /**
     * The documents of the stream ([202] to [211], COD-75): directives, markers, comments and one document, whose
     * node is the value; a second document is met where it starts, and the reader reads nothing of it.
     */
    private static function yamlDocuments(\stdClass $r): mixed
    {
        $read = false;
        $value = null;
        while (true) {
            $indent = self::yamlNextLine($r);
            if ($indent < 0) {
                break;
            }
            $p = $r->p;
            if ($read && ($indent > 0 || self::yamlMarker($r, $p) !== '...')) {
                throw self::yamlRule('multiple documents are not supported');
            }
            if ($indent === 0 && $r->s[$p] === '%') {
                self::yamlDirectives($r);
                $p = $r->p;
            }
            $marker = $indent === 0 ? self::yamlMarker($r, $p) : '';
            if ($marker === '...') {
                $r->p = $p + 3;
                self::yamlLineEnd($r);
                continue;
            }
            if ($marker === '---') {
                $r->p = $p + 3;
                $value = self::yamlRead($r, self::Y_AT_DOCUMENT);
            } else {
                $value = self::yamlRead($r, self::Y_AT_LINES);
            }
            $read = true;
            $indent = self::yamlNextLine($r);
            if ($indent < 0) {
                break;
            }
            $marker = $indent === 0 ? self::yamlMarker($r, $r->p) : '';
            if ($marker === '---') {
                throw self::yamlRule('multiple documents are not supported');
            }
            if ($marker !== '...') {
                self::yamlParseError($r, $r->p + $indent);
            }
            $r->p += 3;
            self::yamlLineEnd($r);
        }
        if (!$read) {
            throw self::yamlRule('no document');
        }
        return $value;
    }

    /**
     * The directives of a document ([82] to [98], COD-75), which its `---` follows: `%YAML 1.2` once, `%TAG` once for a
     * handle, and no other. The reader then stands at the marker.
     */
    private static function yamlDirectives(\stdClass $r): void
    {
        $s = $r->s;
        $end = $r->end;
        $version = false;
        $handles = [];
        while (true) {
            $indent = self::yamlNextLine($r);
            $p = $r->p;
            if ($indent !== 0 || $s[$p] !== '%') {
                break;
            }
            $q = $p + 1;
            while ($q < $end && !self::yamlSep($s[$q])) {
                $q++;
            }
            $name = substr($s, $p + 1, $q - $p - 1);
            if ($name !== 'YAML' && $name !== 'TAG') {
                self::yamlParseError($r, $p);
            }
            if ($q >= $end || ($s[$q] !== ' ' && $s[$q] !== "\t")) {
                self::yamlParseError($r, $q);
            }
            while ($q < $end && ($s[$q] === ' ' || $s[$q] === "\t")) {
                $q++;
            }
            $start = $q;
            if ($name === 'YAML') {
                while ($q < $end && !self::yamlSep($s[$q])) {
                    $q++;
                }
                if ($version || substr($s, $start, $q - $start) !== '1.2') {
                    self::yamlParseError($r, $start);
                }
                $version = true;
            } else {
                // c-tag-handle: !, !! or ! word characters !, then ns-tag-prefix.
                $q = $start + 1;
                if (self::yamlAt($r, $start) !== '!') {
                    self::yamlParseError($r, $start);
                }
                while ($q < $end && (self::yamlWordChar($s[$q]) || $s[$q] === '-')) {
                    $q++;
                }
                if (self::yamlAt($r, $q) === '!') {
                    $q++;
                } elseif ($q > $start + 1) {
                    self::yamlParseError($r, $q);
                }
                $handle = substr($s, $start, $q - $start);
                if (isset($handles[$handle]) || ($q < $end && $s[$q] !== ' ' && $s[$q] !== "\t") || $q >= $end) {
                    self::yamlParseError($r, $start);
                }
                $handles[$handle] = true;
                while ($q < $end && ($s[$q] === ' ' || $s[$q] === "\t")) {
                    $q++;
                }
                $prefix = $q;
                if (self::yamlAt($r, $q) === '!') {
                    $q++;
                } elseif (($q = self::yamlUri($r, $q, true)) === $prefix) {
                    self::yamlParseError($r, $prefix);
                }
                $q = self::yamlUri($r, $q, false);
                if (!self::yamlSep(self::yamlAt($r, $q))) {
                    self::yamlParseError($r, $q);
                }
            }
            $r->p = $q;
            self::yamlLineEnd($r);
        }
        if ($indent !== 0 || self::yamlMarker($r, $r->p) !== '---') {
            self::yamlParseError($r, $r->p + max($indent, 0));
        }
    }

    /**
     * The end of the URI characters from $p (ns-uri-char [39]), a `%` with two hexadecimal digits among them; with
     * $tag, of one tag character at most (ns-tag-char [40]: no `!` and no flow indicator).
     */
    private static function yamlUri(\stdClass $r, int $p, bool $tag): int
    {
        $s = $r->s;
        $end = $r->end;
        while ($p < $end) {
            $c = $s[$p];
            if ($c === '%') {
                if ($p + 2 >= $end || !self::yamlHexDigit($s[$p + 1]) || !self::yamlHexDigit($s[$p + 2])) {
                    break;
                }
                $p += 3;
            } elseif (self::yamlWordChar($c) || strpbrk($c, "-#;/?:@&=+$,_.!~*'()[]") !== false) {
                if ($tag && ($c === '!' || self::yamlFlowIndicator($c))) {
                    break;
                }
                $p++;
            } else {
                break;
            }
            if ($tag) {
                break;
            }
        }
        return $p;
    }

    /**
     * A node of the read ahead is read: the node itself, or the key or the value of the open entry of the top frame
     * $frame, [closing bracket, state, whether its key is a JSON node].
     *
     * @param array{string, int, bool} $frame
     */
    private static function yamlAheadRead(array &$frame, bool $json): void
    {
        if ($frame[1] === 4) {
            $frame[1] = 5;
        } else {
            $frame[1] = 3;
            $frame[2] = $json;
        }
    }

    /**
     * The end of the properties and the node at $p that the read ahead reads (COD-80), on one line before $r->end, as
     * the grammar holds it ([96] to [104], [137] to [161]); $json is whether the node is a quoted scalar or a flow
     * collection. Returns -1, or the place where the node leaves the grammar.
     */
    private static function yamlAheadNode(\stdClass $r, int $p, bool $in, int &$out, bool &$json): int
    {
        $s = $r->s;
        $end = $r->end;
        // A frame of an open flow collection: its closing bracket, its state, and whether its key is a JSON node.
        // States: 0 the first entry or the end, 1 an entry after a comma, 2 after `?`, 3 after a key, 4 after `:`,
        // 5 after an entry.
        $stack = [];
        $node = true;
        while (true) {
            if ($node) {
                $node = false;
                $inside = $in || $stack !== [];
                $properties = false;
                $alias = false;
                while (true) {
                    $c = self::yamlAt($r, $p);
                    if ($c === '&' || $c === '*') {
                        if ($c === '*' && $properties) {
                            return $p;
                        }
                        $alias = $c === '*';
                        $q = $p + 1;
                        while ($q < $end && !self::yamlSep($s[$q]) && !self::yamlFlowIndicator($s[$q])) {
                            $q++;
                        }
                        if ($q === $p + 1) {
                            return $q;
                        }
                        $p = $q;
                    } elseif ($c === '!') {
                        $q = $p + 1;
                        if (self::yamlAt($r, $q) === '<') {
                            $q = self::yamlUri($r, $q + 1, false);
                            if ($q === $p + 2 || self::yamlAt($r, $q) !== '>') {
                                return $q;
                            }
                            $q++;
                        } else {
                            $w = $q;
                            while ($w < $end && (self::yamlWordChar($s[$w]) || $s[$w] === '-')) {
                                $w++;
                            }
                            if (self::yamlAt($r, $w) === '!') {
                                $q = $w + 1;
                                $start = $q;
                                while (($next = self::yamlUri($r, $q, true)) > $q) {
                                    $q = $next;
                                }
                                if ($q === $start) {
                                    return $q;
                                }
                            } else {
                                while (($next = self::yamlUri($r, $q, true)) > $q) {
                                    $q = $next;
                                }
                            }
                        }
                        $p = $q;
                    } else {
                        break;
                    }
                    $properties = true;
                    if ($alias) {
                        break;
                    }
                    $c = self::yamlAt($r, $p);
                    if ($c !== ' ' && $c !== "\t") {
                        break;
                    }
                    while ($p < $end && ($s[$p] === ' ' || $s[$p] === "\t")) {
                        $p++;
                    }
                }
                $c = self::yamlAt($r, $p);
                $text = '';
                if ($alias) {
                    $nodeJson = false;
                } elseif ($c === '[' || $c === '{') {
                    $stack[] = [$c === '[' ? ']' : '}', 0, false];
                    $p++;
                    continue;
                } elseif ($c === '"' || $c === "'") {
                    $fail = self::yamlQuoted($r, $p, false, 0, $text);
                    if ($fail >= 0) {
                        return $fail;
                    }
                    $nodeJson = true;
                } elseif (self::yamlPlainFirst($r, $p, $inside)) {
                    self::yamlPlain($r, $p, $inside, false, 0, $text);
                    $nodeJson = false;
                } elseif ($properties) {
                    $nodeJson = false;
                } else {
                    return $p;
                }
                // A node is read: the node itself, or the key or the value of the open entry.
                if ($stack === []) {
                    $out = $p;
                    $json = $nodeJson;
                    return -1;
                }
                self::yamlAheadRead($stack[count($stack) - 1], $nodeJson);
            }
            $white = false;
            while ($p < $end && ($s[$p] === ' ' || $s[$p] === "\t")) {
                $p++;
                $white = true;
            }
            if ($p >= $end || $s[$p] === '#' || $s[$p] === "\n") {
                return $p;
            }
            $top = count($stack) - 1;
            [$close, $state, $keyJson] = $stack[$top];
            $c = $s[$p];
            // A `:` that no plain scalar holds, at the start of an entry or after `?`, follows an empty key; it is no
            // closing bracket, `,` or `?`, so no rule of those states below meets it first.
            if ($state <= 2 && $c === ':' && !self::yamlSafe(self::yamlAt($r, $p + 1), true)) {
                $stack[$top][1] = 4;
                $stack[$top][2] = false;
                $p++;
                continue;
            }
            if ($state === 0 || $state === 1) {
                if ($c === $close) {
                    array_pop($stack);
                    $p++;
                    if ($stack === []) {
                        $out = $p;
                        $json = true;
                        return -1;
                    }
                    self::yamlAheadRead($stack[$top - 1], true);
                    continue;
                }
                if ($c === ',') {
                    return $p;
                }
                if ($c === '?' && self::yamlSep(self::yamlAt($r, $p + 1))) {
                    $stack[$top][1] = 2;
                    $p++;
                    continue;
                }
                $node = true;
                continue;
            }
            if ($state === 2) {
                if ($c === ',' || $c === $close) {
                    $stack[$top][1] = 5;
                    continue;
                }
                $node = true;
                continue;
            }
            if ($state === 3) {
                if ($c === ':' && ($keyJson || !self::yamlSafe(self::yamlAt($r, $p + 1), true))) {
                    $stack[$top][1] = 4;
                    $p++;
                    continue;
                }
                $stack[$top][1] = 5;
                continue;
            }
            if ($state === 4) {
                if ($c === ',' || $c === $close || (!$keyJson && !$white)) {
                    $stack[$top][1] = 5;
                    continue;
                }
                $node = true;
                continue;
            }
            if ($c === ',') {
                $stack[$top][1] = 1;
                $p++;
                continue;
            }
            if ($c === $close) {
                $stack[$top][1] = 1;
                continue;
            }
            return $p;
        }
    }

    /**
     * The read ahead of COD-80: whether the node at $p is an implicit key, a node on its line that the grammar holds,
     * of at most 1024 characters before the `:` that follows it (COD-76, COD-77); $in is a key of a flow sequence. It
     * applies no rule. For a node that is no key, $fail is the place where the read ahead stops.
     */
    private static function yamlAhead(\stdClass $r, int $p, bool $in, int &$fail): bool
    {
        $s = $r->s;
        $end = $r->end;
        $lineEnd = self::yamlLineStop($r, $p);
        $limit = $p;
        for ($chars = 0; $limit < $lineEnd && $chars < 1024; $chars++) {
            $limit += self::yamlCharLength($s[$limit]);
        }
        $trunc = $r->trunc;
        $r->end = $limit;
        $r->trunc = false;
        $after = $p;
        $json = false;
        $stop = self::yamlAheadNode($r, $p, $in, $after, $json);
        $r->end = $end;
        $r->trunc = $trunc;
        if ($stop >= 0) {
            $fail = $stop;
            return false;
        }
        while ($after < $lineEnd && ($s[$after] === ' ' || $s[$after] === "\t")) {
            $after++;
        }
        if ($after > $limit || $after >= $lineEnd || $s[$after] !== ':') {
            $fail = min($after, $limit);
            return false;
        }
        $next = self::yamlAt($r, $after + 1);
        if ($in ? $json || !self::yamlSafe($next, true) : self::yamlSep($next)) {
            return true;
        }
        $fail = $after;
        return false;
    }

    /** The `:` after the key of an implicit entry, met on the line of the key; the reader then stands after it. */
    private static function yamlColon(\stdClass $r): void
    {
        $p = $r->p;
        while ($p < $r->end && ($r->s[$p] === ' ' || $r->s[$p] === "\t")) {
            $p++;
        }
        if (self::yamlAt($r, $p) !== ':') {
            self::yamlParseError($r, $p);
        }
        $r->p = $p + 1;
    }

    /**
     * The node of a document, read by the frames of the open collections in an explicit stack, so that no depth of the
     * stream and no depth of the caller decides the read (COD-70). $where is where the node starts: on the next lines,
     * or on the line of `---`.
     */
    private static function yamlRead(\stdClass $r, int $where): mixed
    {
        /** @var list<\stdClass> $stack */
        $stack = [];
        // The node the reader reads next: [block, n, out or in, where or single, key]. A block node of a collection
        // indented by n (s-l+block-node), or a flow node whose lines are indented by n (ns-flow-node).
        $request = [true, -1, false, $where, false];
        $have = false;
        $value = null;
        $json = false;
        while (true) {
            if ($request !== null) {
                [$block, $n, $flag, $mode, $key] = $request;
                $request = null;
                $have = $block
                    ? self::yamlBlockNode($r, $stack, $n, $flag, $mode, $key, $request, $value, $json)
                    : self::yamlFlowNode($r, $stack, $n, $flag, $mode, $key, $value, $json);
                continue;
            }
            if ($stack === []) {
                return $value;
            }
            $f = $stack[count($stack) - 1];
            if ($have) {
                $have = false;
                switch ($f->t) {
                    case self::Y_TRAIL:
                        self::yamlLineEnd($r);
                        array_pop($stack);
                        $have = true;
                        break;
                    case self::Y_BLOCK_SEQUENCE:
                        $f->v[] = $value;
                        $f->st = 2;
                        break;
                    case self::Y_BLOCK_MAPPING:
                        if ($f->st === 1) {
                            self::yamlKey($f, $value, $json);
                            self::yamlColon($r);
                            $request = [true, $f->m, true, self::Y_AT_COLON, false];
                            $f->st = 4;
                        } elseif ($f->st === 2) {
                            self::yamlKey($f, $value, $json);
                            $f->st = 3;
                        } elseif ($f->st === 4) {
                            $f->v[$f->k] = $value;
                            $f->st = 5;
                        } else {
                            self::yamlParseError($r, $f->f);
                        }
                        break;
                    case self::Y_FLOW_SEQUENCE:
                        $f->v[] = $value;
                        $f->st = 3;
                        break;
                    case self::Y_FLOW_MAPPING:
                        if ($f->st === 2) {
                            self::yamlKey($f, $value, $json);
                            $f->st = 5;
                        } else {
                            $f->v[$f->k] = $value;
                            $f->st = 4;
                        }
                        break;
                    default:
                        if ($f->st === 3) {
                            array_pop($stack);
                            $r->level--;
                            $value = [$f->k => $value];
                            $json = true;
                            $have = true;
                            break;
                        }
                        $f->k = $value;
                        $f->j = $json;
                        if ($f->st === 1) {
                            self::yamlColon($r);
                            $f->st = 4;
                        } else {
                            $f->st = 5;
                        }
                }
                continue;
            }
            $close = false;
            switch ($f->t) {
                case self::Y_BLOCK_SEQUENCE:
                    if ($f->st === 0) {
                        $r->p++;
                        $request = [true, $f->m, false, self::Y_AT_INDICATOR, false];
                        $f->st = 1;
                        break;
                    }
                    $indent = self::yamlNextLine($r);
                    if ($indent < 0 || ($indent === 0 && self::yamlMarker($r, $r->p) !== '')) {
                        $close = true;
                        break;
                    }
                    $q = $r->p + $indent;
                    if ($indent === $f->m && $r->s[$q] === '-' && self::yamlSep(self::yamlAt($r, $q + 1))) {
                        $r->p = $q;
                        $f->st = 0;
                    } elseif ($indent > $f->m) {
                        self::yamlParseError($r, self::yamlTextStart($r, $q));
                    } else {
                        $close = true;
                    }
                    break;
                case self::Y_BLOCK_MAPPING:
                    $close = self::yamlBlockMappingStep($r, $f, $request);
                    break;
                case self::Y_FLOW_SEQUENCE:
                    $close = self::yamlFlowSequenceStep($r, $stack, $f, $request);
                    break;
                case self::Y_FLOW_MAPPING:
                    $close = self::yamlFlowMappingStep($r, $f, $request);
                    break;
                default:
                    if (self::yamlPairStep($r, $f, $request)) {
                        array_pop($stack);
                        $r->level--;
                        $value = [$f->k => null];
                        $json = true;
                        $have = true;
                    }
            }
            if ($close) {
                array_pop($stack);
                $r->level--;
                $value = $f->v;
                $json = true;
                $have = true;
            }
        }
    }

    /** The first character after the spaces and tabs from $p, where a line of content leaves the grammar. */
    private static function yamlTextStart(\stdClass $r, int $p): int
    {
        while ($p < $r->end && ($r->s[$p] === ' ' || $r->s[$p] === "\t")) {
            $p++;
        }
        return $p;
    }

    /**
     * A block node (s-l+block-node [196]) inside a block collection indented by $n spaces, $out for the value of a map
     * entry (block-out, where a sequence may stand at the indentation of its key, seq-space [201]): on the line where
     * it starts, after an indicator, a `:` of an implicit key or `---`, or on the next lines. Returns whether it is
     * read as $value; otherwise it has opened a frame or asked for a flow node.
     *
     * @param list<\stdClass> $stack
     */
    private static function yamlBlockNode(
        \stdClass $r,
        array &$stack,
        int $n,
        bool $out,
        int $where,
        bool $key,
        ?array &$request,
        mixed &$value,
        bool &$json
    ): bool {
        $s = $r->s;
        $end = $r->end;
        if ($where !== self::Y_AT_LINES) {
            $p = $r->p;
            $spaces = true;
            while ($p < $end && ($s[$p] === ' ' || $s[$p] === "\t")) {
                $spaces = $spaces && $s[$p] === ' ';
                $p++;
            }
            if ($p < $end && $s[$p] !== '#' && $s[$p] !== "\n") {
                $r->p = $p;
                $compact = $where === self::Y_AT_INDICATOR && $spaces;
                return self::yamlBlockContent($r, $stack, $n, $compact, $key, $request, $value, $json);
            }
            $p = self::yamlLineStop($r, $p);
            $r->p = $p < $end ? $p + 1 : $p;
        }
        $indent = self::yamlNextLine($r);
        if ($indent >= 0 && !($indent === 0 && self::yamlMarker($r, $r->p) !== '')) {
            $q = $r->p + $indent;
            $c = $s[$q];
            $next = self::yamlAt($r, $q + 1);
            if ($c === '-' && self::yamlSep($next) && ($indent > $n || ($out && $indent === $n))) {
                self::yamlOpen($r, $key);
                $r->p = $q;
                $stack[] = self::yamlFrame(self::Y_BLOCK_SEQUENCE, 0, $indent);
                return false;
            }
            if ($indent > $n) {
                $fail = 0;
                $indicator = ($c === '?' || $c === ':') && self::yamlSep($next);
                if ($indicator || self::yamlAhead($r, $q, false, $fail)) {
                    self::yamlOpen($r, $key);
                    $r->p = $q;
                    $f = self::yamlFrame(self::Y_BLOCK_MAPPING, 0, $indent);
                    $f->known = !$indicator;
                    $stack[] = $f;
                    return false;
                }
                $r->p = self::yamlTextStart($r, $q);
                return self::yamlBlockContent($r, $stack, $n, false, $key, $request, $value, $json);
            }
        }
        if ($key) {
            throw self::yamlRule('map keys must be strings or integers');
        }
        $value = null;
        $json = false;
        return true;
    }

    /**
     * The block node that starts at $r->p on its line: its properties, which the codec refuses where they stand; with
     * $compact, after an indicator and spaces, a compact sequence or mapping (s-l+block-indented [185]); a block
     * scalar; or a flow node and the rest of its line (s-l+flow-in-block [197]).
     *
     * @param list<\stdClass> $stack
     */
    private static function yamlBlockContent(
        \stdClass $r,
        array &$stack,
        int $n,
        bool $compact,
        bool $key,
        ?array &$request,
        mixed &$value,
        bool &$json
    ): bool {
        $s = $r->s;
        $p = $r->p;
        $c = $s[$p];
        self::yamlProperty($c);
        if ($compact) {
            $column = $p;
            while ($column > 0 && $s[$column - 1] !== "\n") {
                $column--;
            }
            $column = $p - $column;
            $next = self::yamlAt($r, $p + 1);
            $fail = 0;
            if ($c === '-' && self::yamlSep($next)) {
                self::yamlOpen($r, $key);
                $stack[] = self::yamlFrame(self::Y_BLOCK_SEQUENCE, 0, $column);
                return false;
            }
            $indicator = ($c === '?' || $c === ':') && self::yamlSep($next);
            if ($indicator || self::yamlAhead($r, $p, false, $fail)) {
                self::yamlOpen($r, $key);
                $f = self::yamlFrame(self::Y_BLOCK_MAPPING, 0, $column);
                $f->known = !$indicator;
                $stack[] = $f;
                return false;
            }
        }
        if ($c === '|' || $c === '>') {
            $value = self::yamlBlockScalar($r, $n);
            $json = true;
            return true;
        }
        $stack[] = self::yamlFrame(self::Y_TRAIL, 0, 0);
        $request = [false, $n + 1, false, false, $key];
        return false;
    }

    /** The properties and the alias, which the codec refuses at the character that starts them (COD-79). */
    private static function yamlProperty(string $c): void
    {
        if ($c === '&') {
            throw self::yamlRule('anchors are not supported');
        }
        if ($c === '!') {
            throw self::yamlRule('explicit tags are not supported');
        }
        if ($c === '*') {
            throw self::yamlRule('aliases are not supported');
        }
    }

    /**
     * A flow node at $r->p (ns-flow-node [161]) whose lines are indented by $need spaces, $in inside a flow collection,
     * $single for an implicit key, which is one line: a collection opens its frame, and a scalar is read as $value,
     * by the rules of a key with $key. Returns whether it is read.
     *
     * @param list<\stdClass> $stack
     */
    private static function yamlFlowNode(
        \stdClass $r,
        array &$stack,
        int $need,
        bool $in,
        bool $single,
        bool $key,
        mixed &$value,
        bool &$json
    ): bool {
        $p = $r->p;
        $c = self::yamlAt($r, $p);
        self::yamlProperty($c);
        if ($c === '[' || $c === '{') {
            self::yamlOpen($r, $key);
            $stack[] = self::yamlFrame($c === '[' ? self::Y_FLOW_SEQUENCE : self::Y_FLOW_MAPPING, 0, $need);
            $r->p = $p + 1;
            return false;
        }
        $text = '';
        if ($c === '"' || $c === "'") {
            $fail = self::yamlQuoted($r, $p, !$single, $need, $text);
            $json = true;
            $value = $text;
        } elseif (self::yamlPlainFirst($r, $p, $in)) {
            $fail = self::yamlPlain($r, $p, $in, !$single, $need, $text);
            if ($fail < 0) {
                $value = self::yamlResolve($text, $key);
            }
            $json = false;
        } else {
            $fail = $p;
        }
        if ($fail >= 0) {
            self::yamlParseError($r, $fail);
        }
        $r->p = $p;
        return true;
    }

    /** A step of an open block mapping; returns whether it ends. */
    private static function yamlBlockMappingStep(\stdClass $r, \stdClass $f, ?array &$request): bool
    {
        $s = $r->s;
        if ($f->st === 0) {
            $p = $r->p;
            $c = $s[$p];
            $next = self::yamlAt($r, $p + 1);
            if ($c === '?' && self::yamlSep($next)) {
                $r->p = $p + 1;
                $request = [true, $f->m, true, self::Y_AT_INDICATOR, true];
                $f->st = 2;
                return false;
            }
            if ($c === ':' && self::yamlSep($next)) {
                throw self::yamlRule('map keys must be strings or integers');
            }
            $fail = 0;
            if ($f->known || self::yamlAhead($r, $p, false, $fail)) {
                $request = [false, $f->m + 1, false, true, true];
                $f->st = 1;
            } else {
                // A node that is no key: the rules of the nodes before the place where it leaves the grammar, or
                // where the read ahead ends with no `:`, then yaml-parse there (COD-80).
                $r->trunc = true;
                $r->end = min($r->end, $fail);
                $f->f = $fail;
                $request = [false, $f->m + 1, false, true, false];
                $f->st = 6;
            }
            $f->known = false;
            return false;
        }
        $indent = self::yamlNextLine($r);
        if ($f->st === 3) {
            $q = $r->p + $indent;
            if ($indent === $f->m && $s[$q] === ':' && self::yamlSep(self::yamlAt($r, $q + 1))) {
                $r->p = $q + 1;
                $request = [true, $f->m, true, self::Y_AT_INDICATOR, false];
                $f->st = 4;
                return false;
            }
            $f->v[$f->k] = null;
            $f->st = 5;
        }
        if ($indent < 0 || ($indent === 0 && self::yamlMarker($r, $r->p) !== '') || $indent < $f->m) {
            return true;
        }
        $q = $r->p + $indent;
        if ($indent > $f->m || $s[$q] === "\t") {
            self::yamlParseError($r, self::yamlTextStart($r, $q));
        }
        $r->p = $q;
        $f->st = 0;
        return false;
    }

    /**
     * The `,` or the closing bracket $close after an entry of a flow collection ($after), or its first entry; a `,`
     * with no entry before it is yaml-parse. Returns whether the closing bracket ends the collection, the reader then
     * past it.
     */
    private static function yamlFlowEntry(\stdClass $r, int $need, bool $after, string $close): bool
    {
        self::yamlFlowSpace($r, $need);
        $c = self::yamlAt($r, $r->p);
        if ($after) {
            if ($c !== ',' && $c !== $close) {
                self::yamlParseError($r, $r->p);
            }
            if ($c === ',') {
                $r->p++;
                self::yamlFlowSpace($r, $need);
                $c = self::yamlAt($r, $r->p);
            }
        } elseif ($c === ',') {
            self::yamlParseError($r, $r->p);
        }
        if ($c === $close) {
            $r->p++;
            return true;
        }
        if ($c === ',') {
            self::yamlParseError($r, $r->p);
        }
        return false;
    }

    /**
     * A step of an open flow sequence ([137] to [139]); an entry that is an implicit key, an explicit `?` or an empty
     * key is a pair, a map of one entry that opens its own frame (ns-flow-pair [150]). Returns whether it ends.
     *
     * @param list<\stdClass> $stack
     */
    private static function yamlFlowSequenceStep(\stdClass $r, array &$stack, \stdClass $f, ?array &$request): bool
    {
        if ($f->st === 0 || $f->st === 3) {
            if (self::yamlFlowEntry($r, $f->m, $f->st === 3, ']')) {
                return true;
            }
            $f->st = 1;
        }
        $p = $r->p;
        $c = self::yamlAt($r, $p);
        $next = self::yamlAt($r, $p + 1);
        $f->st = 2;
        if ($c === '?' && self::yamlSep($next)) {
            self::yamlOpen($r, false);
            $r->p = $p + 1;
            $stack[] = self::yamlFrame(self::Y_PAIR, 0, $f->m);
            return false;
        }
        if ($c === ':' && !self::yamlSafe($next, true)) {
            self::yamlOpen($r, false);
            throw self::yamlRule('map keys must be strings or integers');
        }
        $fail = 0;
        if ($c !== '' && self::yamlAhead($r, $p, true, $fail)) {
            self::yamlOpen($r, false);
            $stack[] = self::yamlFrame(self::Y_PAIR, 1, $f->m);
            $request = [false, $f->m, true, true, true];
            return false;
        }
        $request = [false, $f->m, true, false, false];
        return false;
    }

    /** A step of an open flow mapping ([140] to [149]); returns whether it ends. */
    private static function yamlFlowMappingStep(\stdClass $r, \stdClass $f, ?array &$request): bool
    {
        if ($f->st === 5) {
            self::yamlFlowSpace($r, $f->m);
            $p = $r->p;
            $c = self::yamlAt($r, $p);
            if ($c === ':' && ($f->j || !self::yamlSafe(self::yamlAt($r, $p + 1), true))) {
                $r->p = $p + 1;
                if ($f->j || self::yamlSep(self::yamlAt($r, $p + 1))) {
                    self::yamlFlowSpace($r, $f->m);
                    $c = self::yamlAt($r, $r->p);
                    if ($c !== ',' && $c !== '}') {
                        $request = [false, $f->m, true, false, false];
                        $f->st = 3;
                        return false;
                    }
                }
            } elseif ($c !== ',' && $c !== '}') {
                self::yamlParseError($r, $p);
            }
            $f->v[$f->k] = null;
            $f->st = 4;
        }
        if (($f->st === 0 || $f->st === 4) && self::yamlFlowEntry($r, $f->m, $f->st === 4, '}')) {
            return true;
        }
        $p = $r->p;
        $c = self::yamlAt($r, $p);
        $next = self::yamlAt($r, $p + 1);
        if ($c === '?' && self::yamlSep($next)) {
            $r->p = $p + 1;
            self::yamlFlowSpace($r, $f->m);
            $p = $r->p;
            $c = self::yamlAt($r, $p);
            $next = self::yamlAt($r, $p + 1);
            if ($c === ',' || $c === '}') {
                throw self::yamlRule('map keys must be strings or integers');
            }
        }
        if ($c === ':' && !self::yamlSafe($next, true)) {
            throw self::yamlRule('map keys must be strings or integers');
        }
        $request = [false, $f->m, true, false, true];
        $f->st = 2;
        return false;
    }

    /**
     * A step of the pair of a flow sequence: after `?`, its key; after its key, the `:` and the value, which is empty
     * when nothing follows (e-node). Returns whether the pair ends with a null value.
     */
    private static function yamlPairStep(\stdClass $r, \stdClass $f, ?array &$request): bool
    {
        if ($f->st === 0) {
            self::yamlFlowSpace($r, $f->m);
            $p = $r->p;
            $c = self::yamlAt($r, $p);
            $colon = $c === ':' && !self::yamlSafe(self::yamlAt($r, $p + 1), true);
            if ($colon || $c === ',' || $c === ']' || $c === '}') {
                throw self::yamlRule('map keys must be strings or integers');
            }
            $request = [false, $f->m, true, false, true];
            $f->st = 2;
            return false;
        }
        if ($f->st === 5) {
            self::yamlFlowSpace($r, $f->m);
            $p = $r->p;
            if (self::yamlAt($r, $p) !== ':' || !($f->j || !self::yamlSafe(self::yamlAt($r, $p + 1), true))) {
                return true;
            }
            $r->p = $p + 1;
        }
        // The value after the `:`, which follows a key that is no JSON node only after white space
        // (c-ns-flow-map-separate-value).
        if (!$f->j && !self::yamlSep(self::yamlAt($r, $r->p))) {
            return true;
        }
        self::yamlFlowSpace($r, $f->m);
        $c = self::yamlAt($r, $r->p);
        if ($c === ',' || $c === ']' || $c === '}') {
            return true;
        }
        $request = [false, $f->m, true, false, false];
        $f->st = 3;
        return false;
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

    /**
     * The ORM-AES2 envelope of the bytes: the prefix, a random 12-byte nonce, the AES-256-GCM ciphertext and its tag.
     */
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
