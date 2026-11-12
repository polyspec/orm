<?php

declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

use Polyspec\Orm\Message;

/**
 * The set reader of Dbspec::readSet (docs/spec/dbspec.md "Document sets"): the set file, its JSON, each path
 * and the read with the file identity, in that order.
 *
 * @internal
 */
final class SetReader
{
    /** The name of every set file. */
    public const NAME = 'dbspec-set.json';

    /** The deepest nesting of the set file, the object counting as one. */
    private const DEPTH = 64;

    /**
     * The depth that json_decode is given: the set file's own depth check reads the nesting, so the parser checks
     * only the syntax.
     */
    private const PARSER_DEPTH = 2147483646;

    /** A JSON string (RFC 8259), possessive so that a long string does not backtrack. */
    private const JSON_STRING = '"(?:[^"\\\\\x00-\x1F]++|\\\\(?:["\\\\\/bfnrt]|u[0-9A-Fa-f]{4}))*+"';

    /** A JSON number or literal (RFC 8259). */
    private const JSON_SCALAR = '-?(?:0|[1-9][0-9]*+)(?:\.[0-9]++)?(?:[eE][+-]?[0-9]++)?|true|false|null';

    /** @var array<string, list<string>|false> the listing of each directory during one read */
    private array $listings = [];

    /** @var array<string, string> the warning from a failed cached directory listing */
    private array $listingFailures = [];

    /** The cause of the immediately preceding failed stat or listing operation. */
    private ?string $failure = null;

    private function __construct(private readonly bool $windows)
    {
    }

    public static function read(string $path): SetResult
    {
        // PHP keeps the last stat of a path; a later read of a changed tree must examine it again.
        clearstatcache();
        return (new self(PHP_OS_FAMILY === 'Windows'))->run($path);
    }

    private function run(string $path): SetResult
    {
        // Step 1: the set file.
        $cut = $this->lastSeparator($path);
        $prefix = substr($path, 0, $cut + 1);
        $root = $prefix === '' ? '.' : $prefix;
        $fail = static fn(string $rule, string $message): SetResult => SetResult::invalid(
            [new SetError($rule, $path, $message)]
        );
        if (substr($path, $cut + 1) !== self::NAME) {
            return $fail('set.file', "$path: the set file is not named " . self::NAME);
        }
        if (str_contains($path, "\0")) {
            return $fail('set.file', "$path: the path contains a NUL byte");
        }
        $named = $this->trimmed($root);
        $kind = $this->kind($named);
        if ($kind === null) {
            return $fail('set.file', "$path: the root $named cannot be examined" . $this->failure);
        }
        if ($kind === 'link') {
            return $fail('set.symlink', "$path: the root $named is a symbolic link");
        }
        if ($kind !== 'dir') {
            return $fail('set.file', "$path: the root $named is not a directory");
        }
        $listed = $this->lists($root, self::NAME);
        if ($listed === null) {
            return $fail('set.file', "$path: the root $named cannot be listed" . $this->failure);
        }
        if (!$listed) {
            return $fail('set.file', "$path: the root $named lists no " . self::NAME);
        }
        $kind = $this->kind($path);
        if ($kind === null) {
            return $fail('set.file', "$path: the set file cannot be examined" . $this->failure);
        }
        if ($kind === 'link') {
            return $fail('set.symlink', "$path: the set file is a symbolic link");
        }
        if ($kind !== 'file') {
            return $fail('set.file', "$path: the set file is not a regular file");
        }
        $opened = self::open($path, 'the set file');
        if ($opened instanceof SetError) {
            return SetResult::invalid([$opened]);
        }
        [, $bytes] = $opened;

        // Step 2: the JSON.
        $parsed = $this->parse($bytes, $path);
        if ($parsed instanceof SetError) {
            return SetResult::invalid([$parsed]);
        }

        // Step 3: each path, documents first and then external, in written order.
        $errors = [];
        $passed = [];
        foreach (['documents', 'external'] as $list) {
            foreach ($parsed[$list] as $written) {
                $wrong = self::normalForm($written, $list);
                if ($wrong !== null) {
                    $errors[] = new SetError('set.path', $path, "$path: the $list path "
                        . Message::quote($written) . " $wrong");
                    continue;
                }
                $joined = $prefix . $written;
                $error = $this->examine($root, $named, $prefix, $written, $joined, $list === 'external');
                if ($error !== null) {
                    $errors[] = $error;
                    continue;
                }
                $passed[] = [$list, $joined];
            }
        }

        // Step 4: the read and the file identity of each path that passed step 3.
        $files = ['documents' => [], 'external' => []];
        $identities = [];
        foreach ($passed as [$list, $joined]) {
            $opened = self::open($joined, 'the file', $identities);
            if ($opened instanceof SetError) {
                $errors[] = $opened;
                continue;
            }
            [$identity, $fileBytes] = $opened;
            $identities[$identity] = $joined;
            $files[$list][] = new SetFile($joined, $fileBytes);
        }
        return $errors === [] ? SetResult::valid($files['documents'], $files['external']) : SetResult::invalid($errors);
    }

    /** The offset of the last separator of $path, or -1: `/`, and on Windows also `\`. */
    private function lastSeparator(string $path): int
    {
        $slash = strrpos($path, '/');
        $cut = $slash === false ? -1 : $slash;
        if ($this->windows) {
            $back = strrpos($path, '\\');
            $cut = max($cut, $back === false ? -1 : $back);
        }
        return $cut;
    }

    /**
     * The root without its trailing separators, so that lstat examines the root itself: POSIX lstat of
     * `alias/` follows the link alias. A root of only separators stays one, and on Windows `C:\` stays.
     */
    private function trimmed(string $root): string
    {
        $separators = $this->windows ? '/\\' : '/';
        $trimmed = rtrim($root, $separators);
        if ($trimmed === '') {
            return $root[0];
        }
        if ($this->windows && strlen($trimmed) === 2 && $trimmed[1] === ':' && strlen($root) > 2) {
            return substr($root, 0, 3);
        }
        return $trimmed;
    }

    /**
     * What $path names without following a symbolic link: 'link', 'dir', 'file' (a regular file), 'other',
     * or null when it cannot be examined. On Windows PHP's lstat reports a symbolic link and a junction,
     * the name surrogates that PHP can see, as a link. With $follow, the target of a link is examined (stat).
     */
    private function kind(string $path, bool $follow = false): ?string
    {
        error_clear_last();
        // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- a missing path returns false, which means no entry
        $stat = $follow ? @stat($path) : @lstat($path);
        if ($stat === false) {
            $this->failure = self::operationFailure();
            return null;
        }
        $this->failure = null;
        return match ($stat['mode'] & 0o170000) {
            0o120000 => 'link',
            0o040000 => 'dir',
            0o100000 => 'file',
            default => 'other',
        };
    }

    /**
     * Whether the directory $dir lists the name $name, compared byte for byte (on Windows PHP lists names
     * as UTF-8, whose bytes are equal exactly when their UTF-16 code units are), or null when $dir cannot
     * be listed.
     */
    private function lists(string $dir, string $name): ?bool
    {
        if (!array_key_exists($dir, $this->listings)) {
            error_clear_last();
            // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- an unreadable folder returns false, which means no listing
            $this->listings[$dir] = @scandir($dir, SCANDIR_SORT_NONE);
            if ($this->listings[$dir] === false) {
                $this->listingFailures[$dir] = self::operationFailure();
            }
        }
        $listing = $this->listings[$dir];
        $this->failure = $listing === false ? $this->listingFailures[$dir] : null;
        return $listing === false ? null : in_array($name, $listing, true);
    }

    /**
     * `: ` and the warning that PHP gave for the failed operation, unchanged (INT-187), read immediately after its
     * failure and never from an earlier operation; empty when PHP gave none, since no error text is made up.
     */
    private static function operationFailure(): string
    {
        $warning = error_get_last();
        return $warning === null ? '' : ': ' . $warning['message'];
    }

    /**
     * Opens $path once and reads its bytes and its identity (device and inode of fstat) from that handle.
     * With $identities, a path whose identity is already there is a duplicate and is not read.
     *
     * @param string $what `the set file` or `the file`, the subject of the message of a failed read
     * @param ?array<string, string> $identities the joined path of each identity read so far
     * @return array{string, string}|SetError the identity and the bytes, or the error
     */
    private static function open(string $path, string $what, ?array $identities = null): array|SetError
    {
        $failed = static fn(): SetError => new SetError(
            'set.file',
            $path,
            "$path: $what cannot be read" . self::operationFailure()
        );
        error_clear_last();
        // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- the warning text is the reason of the failure, read by error_get_last
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            return $failed();
        }
        try {
            // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- the warning text is the reason of the failure, read by error_get_last
            $stat = @fstat($handle);
            if ($stat === false) {
                return $failed();
            }
            $identity = $stat['dev'] . ':' . $stat['ino'];
            if ($identities !== null && isset($identities[$identity])) {
                $earlier = $identities[$identity];
                return new SetError('set.duplicate', $path, "$path: names the file that $earlier names");
            }
            // A failed read of a plain file is a notice and may still return the bytes read before it.
            error_clear_last();
            // phpcs:ignore Generic.PHP.NoSilencedErrors.Discouraged -- the warning text is the reason of the failure, read by error_get_last
            $bytes = @stream_get_contents($handle);
            if ($bytes === false || error_get_last() !== null) {
                return $failed();
            }
            return [$identity, $bytes];
        } finally {
            fclose($handle);
        }
    }

    /**
     * Step 2: the set file's bytes as JSON, checked in the order of DBS-13 and DBS-18a. The standard parser checks
     * the syntax, with every lone surrogate escape written as another escape, since the parser stops at a lone
     * surrogate before the rest of the syntax; when it refuses a text whose syntax is valid only for its nesting,
     * which its stack does not hold, the text is JSON. A scan of the checked text, which only checks and parses no
     * value, finds the kind of the top-level value, the nesting, a repeated key in any object and the kind of each
     * top-level value, which the decoded arrays do not keep.
     *
     * @return array{documents: list<string>, external: list<string>}|SetError
     */
    private function parse(string $bytes, string $path): array|SetError
    {
        $error = static fn(string $rule, string $message): SetError => new SetError($rule, $path, "$path: $message");
        if (str_starts_with($bytes, "\xEF\xBB\xBF")) {
            return $error('set.json', 'the set file starts with a byte order mark');
        }
        if (preg_match('//u', $bytes) !== 1) {
            return $error('set.json', 'the set file is not valid UTF-8');
        }
        $text = self::withoutLoneSurrogates($bytes);
        $value = json_decode($text, true, self::PARSER_DEPTH);
        if (json_last_error() !== JSON_ERROR_NONE) {
            $parser = json_last_error_msg();
            if (!self::json($text)) {
                return $error('set.json', "the set file is not JSON: $parser");
            }
        }
        [$top, $depth, $members, $repeated] = self::scan($text);
        if ($top !== 'object') {
            return $error('set.json', 'the set file is not one JSON object');
        }
        if ($depth > self::DEPTH) {
            return $error('set.json', 'the set file nests deeper than ' . self::DEPTH . ' levels');
        }
        if ($text !== $bytes) {
            return $error('set.json', 'the set file escapes a lone surrogate');
        }
        if ($repeated !== null) {
            return $error('set.key', 'the key ' . Message::quote($repeated) . ' appears twice');
        }
        assert(is_array($value));
        $unknown = array_values(array_diff(array_keys($members), ['schema', 'documents', 'external']));
        if ($unknown !== []) {
            $unknown = array_map('strval', $unknown);
            // Byte order of UTF-8 is code-point order.
            usort($unknown, 'strcmp');
            $quoted = array_map(static fn(string $k): string => Message::quote($k), $unknown);
            return $error('set.key', (count($unknown) === 1 ? 'unknown key ' : 'unknown keys ')
                . implode(', ', $quoted));
        }
        if (!isset($members['schema'])) {
            return $error('set.schema', 'schema is missing');
        }
        $schema = $value['schema'];
        if (!(is_int($schema) && $schema === 1 || is_float($schema) && $schema === 1.0)) {
            return $error('set.schema', 'schema is not the number 1');
        }
        if (!isset($members['documents'])) {
            return $error('set.key', 'documents is missing');
        }
        if (!self::strings($members['documents'], $value['documents'])) {
            return $error('set.key', 'documents is not an array of strings');
        }
        if ($value['documents'] === []) {
            return $error('set.empty', 'documents is empty');
        }
        if (isset($members['external']) && !self::strings($members['external'], $value['external'])) {
            return $error('set.key', 'external is not an array of strings');
        }
        return ['documents' => $value['documents'], 'external' => $value['external'] ?? []];
    }

    /**
     * $text with each escape of a lone surrogate written as `\u0000`; a pair of a high and a low surrogate escape
     * stays, and so does every other escape, so the text is JSON exactly when $text is, but for the surrogates.
     */
    private static function withoutLoneSurrogates(string $text): string
    {
        return (string) preg_replace_callback(
            '/\\\\(?:u[dD][89abAB][0-9a-fA-F]{2}\\\\u[dD][c-fC-F][0-9a-fA-F]{2}|(u[dD][89a-fA-F][0-9a-fA-F]{2})|.)/s',
            static fn(array $m): string => isset($m[1]) ? '\\u0000' : $m[0],
            $text
        );
    }

    /**
     * Whether $text is one JSON value (RFC 8259), read without a stack limit. It decides only the texts that
     * json_decode refuses, so that a valid text nested deeper than the parser's stack is JSON.
     */
    private static function json(string $text): bool
    {
        $n = strlen($text);
        $i = 0;
        $open = [];
        // value: a value; value]: a value or ]; key: a key; key}: a key or }; colon; next: , or the close; end.
        $state = 'value';
        while (true) {
            $i += strspn($text, " \t\n\r", $i);
            if ($i >= $n) {
                return $state === 'end';
            }
            $c = $text[$i];
            if ($state === 'end') {
                return false;
            }
            if ($state === 'colon') {
                if ($c !== ':') {
                    return false;
                }
                $i++;
                $state = 'value';
                continue;
            }
            if ($state === 'next' || ($state === 'value]' && $c === ']') || ($state === 'key}' && $c === '}')) {
                $last = $open[count($open) - 1];
                if ($state === 'next' && $c === ',') {
                    $i++;
                    $state = $last === '{' ? 'key' : 'value';
                    continue;
                }
                if ($c !== ($last === '{' ? '}' : ']')) {
                    return false;
                }
                array_pop($open);
                $i++;
                $state = $open === [] ? 'end' : 'next';
                continue;
            }
            if ($state === 'key' || $state === 'key}') {
                if (preg_match('/\G' . self::JSON_STRING . '/', $text, $m, 0, $i) !== 1) {
                    return false;
                }
                $i += strlen($m[0]);
                $state = 'colon';
                continue;
            }
            if ($c === '{' || $c === '[') {
                $open[] = $c;
                $i++;
                $state = $c === '{' ? 'key}' : 'value]';
                continue;
            }
            if (preg_match('/\G(?:' . self::JSON_STRING . '|' . self::JSON_SCALAR . ')/', $text, $m, 0, $i) !== 1) {
                return false;
            }
            $i += strlen($m[0]);
            $state = $open === [] ? 'end' : 'next';
        }
    }

    /** Whether a top-level value of the kind $kind, decoded as $value, is an array of strings. */
    private static function strings(string $kind, mixed $value): bool
    {
        return $kind === 'array' && array_filter($value, 'is_string') === $value;
    }

    /**
     * Scans JSON text: the kind of the top-level value, the deepest nesting of its containers, the kind of each
     * value of the top-level object by its key, and the first key repeated in an object, at any depth.
     *
     * @return array{string, int, array<string, string>, ?string}
     */
    private static function scan(string $text): array
    {
        $n = strlen($text);
        $top = null;
        $members = [];
        $repeated = null;
        $depth = 0;
        // A frame per open container: [is object, keys seen, expecting a key].
        $frames = [];
        $key = null;
        $value = static function (string $kind) use (&$frames, &$top, &$members, &$key): void {
            if ($frames === []) {
                $top ??= $kind;
            } elseif (count($frames) === 1 && $frames[0][0]) {
                $members[$key] = $kind;
            }
        };
        for ($i = 0; $i < $n; $i++) {
            $c = $text[$i];
            if ($c === ' ' || $c === "\t" || $c === "\n" || $c === "\r" || $c === ':') {
                continue;
            }
            if ($c === '"') {
                $start = $i;
                for ($i++; $text[$i] !== '"'; $i++) {
                    if ($text[$i] === '\\') {
                        $i++;
                    }
                }
                $last = count($frames) - 1;
                if ($last >= 0 && $frames[$last][0] && $frames[$last][2]) {
                    $name = json_decode(substr($text, $start, $i - $start + 1));
                    if (isset($frames[$last][1][$name])) {
                        $repeated ??= $name;
                    }
                    $frames[$last][1][$name] = true;
                    $frames[$last][2] = false;
                    if ($last === 0) {
                        $key = $name;
                    }
                } else {
                    $value('string');
                }
                continue;
            }
            if ($c === '{' || $c === '[') {
                $value($c === '{' ? 'object' : 'array');
                $frames[] = [$c === '{', [], $c === '{'];
                $depth = max($depth, count($frames));
                continue;
            }
            if ($c === '}' || $c === ']') {
                array_pop($frames);
                continue;
            }
            if ($c === ',') {
                $last = count($frames) - 1;
                $frames[$last][2] = $frames[$last][0];
                continue;
            }
            // A number or a literal runs to the next structural character or white space.
            $length = strcspn($text, " \t\n\r,:]}", $i);
            $word = substr($text, $i, $length);
            $value(match ($word) {
                'true', 'false' => 'boolean',
                'null' => 'null',
                default => 'number',
            });
            $i += $length - 1;
        }
        return [(string) $top, $depth, $members, $repeated];
    }

    /**
     * The problem of a written path that has no normal form (DBS-7 to DBS-9), as DBS-18a words it, or null when it
     * has one: the segments are checked from the first, each against the problems in order, and then the path.
     */
    private static function normalForm(string $written, string $list): ?string
    {
        $leading = true;
        foreach (explode('/', $written) as $segment) {
            if ($segment === '') {
                return 'has an empty segment';
            }
            if ($segment === '..') {
                if ($list === 'documents') {
                    return 'has a .. segment';
                }
                if (!$leading) {
                    return 'has a .. segment after another segment';
                }
                continue;
            }
            $leading = false;
            $wrong = self::segment($segment);
            if ($wrong !== null) {
                return $wrong;
            }
        }
        return str_ends_with($written, '.dbs') ? null : 'does not end in .dbs';
    }

    /** The problem of a segment other than `..` that every platform cannot hold (DBS-8), or null. */
    private static function segment(string $segment): ?string
    {
        if ($segment === '.') {
            return 'has a . segment';
        }
        if (preg_match('/[\\\\:<>"|?*\x00-\x1F]/', $segment, $m) === 1) {
            return 'has the character ' . Message::quote($m[0]) . ' that a segment cannot hold';
        }
        if (str_ends_with($segment, '.') || str_ends_with($segment, ' ')) {
            return 'has a segment that ends in . or a space';
        }
        $dot = strpos($segment, '.');
        $base = strtr(
            rtrim($dot === false ? $segment : substr($segment, 0, $dot), ' '),
            'abcdefghijklmnopqrstuvwxyz',
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        );
        if (preg_match('/\A(?:CON|PRN|AUX|NUL|(?:COM|LPT)(?:[0-9]|\xC2\xB9|\xC2\xB2|\xC2\xB3))\z/', $base) === 1) {
            return 'has the segment ' . Message::quote($segment) . ' that names a Windows device';
        }
        return null;
    }

    /**
     * Step 3 for one path that has its normal form: each prefix of the joined path that ends after a
     * written segment is listed by its directory (a segment other than `..`) and examined with lstat. An
     * intermediate component of an external path that is a link is examined through it (stat). $named is the root
     * as the messages name it, the directory that lists the first segment.
     */
    private function examine(
        string $root,
        string $named,
        string $prefix,
        string $written,
        string $joined,
        bool $external
    ): ?SetError {
        $segments = explode('/', $written);
        $last = count($segments) - 1;
        $directory = $root;
        $shown = $named;
        $component = $prefix;
        $fail = static fn(string $rule, string $message): SetError => new SetError($rule, $joined, "$joined: $message");
        foreach ($segments as $i => $segment) {
            $component .= ($i === 0 ? '' : '/') . $segment;
            if ($segment !== '..') {
                $listed = $this->lists($directory, $segment);
                if ($listed === null) {
                    return $fail('set.file', "$shown cannot be listed" . $this->failure);
                }
                if (!$listed) {
                    return $fail('set.file', "$shown lists no name " . Message::quote($segment));
                }
            }
            $kind = $this->kind($component);
            if ($kind === 'link' && $external && $i < $last) {
                $kind = $this->kind($component, true);
            }
            if ($kind === null) {
                return $fail('set.file', "$component cannot be examined" . $this->failure);
            }
            if ($kind === 'link') {
                return $fail('set.symlink', "$component is a symbolic link");
            }
            if ($i < $last && $kind !== 'dir') {
                return $fail('set.file', "$component is not a directory");
            }
            if ($i === $last && $kind !== 'file') {
                return $fail('set.file', "$component is not a regular file");
            }
            $directory = $component;
            $shown = $component;
        }
        return null;
    }
}
