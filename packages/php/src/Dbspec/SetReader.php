<?php
declare(strict_types=1);

namespace Polyspec\Orm\Dbspec;

/**
 * The set reader of Dbspec::readSet (docs/dbspec.md "Document sets"): the set file, its JSON, each path
 * and the read with the file identity, in that order.
 *
 * @internal
 */
final class SetReader
{
    /** The name of every set file. */
    public const NAME = 'dbspec-set.json';

    /** The deepest nesting of the set file; json_decode counts one level more than the containers. */
    private const DEPTH = 64;

    private const JSON_QUOTE = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

    /** @var array<string, list<string>|false> the listing of each directory during one read */
    private array $listings = [];

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
        $fail = static fn(string $rule, string $message): SetResult => SetResult::invalid([new SetError($rule, $path, $message)]);
        if (substr($path, $cut + 1) !== self::NAME) {
            return $fail('set.file', "$path: the set file is not named " . self::NAME);
        }
        if (str_contains($path, "\0")) {
            return $fail('set.file', "$path: the path contains a NUL byte");
        }
        $kind = $this->kind($this->trimmed($root));
        if ($kind === null) {
            return $fail('set.file', "$path: the root $root cannot be examined");
        }
        if ($kind === 'link') {
            return $fail('set.symlink', "$path: the root $root is a symbolic link");
        }
        if ($kind !== 'dir') {
            return $fail('set.file', "$path: the root $root is not a directory");
        }
        $listed = $this->lists($root, self::NAME);
        if ($listed === null) {
            return $fail('set.file', "$path: the directory $root cannot be listed");
        }
        if (!$listed) {
            return $fail('set.file', "$path: " . self::NAME . " is not a name that $root lists");
        }
        $kind = $this->kind($path);
        if ($kind === null) {
            return $fail('set.file', "$path: the set file cannot be examined");
        }
        if ($kind === 'link') {
            return $fail('set.symlink', "$path: the set file is a symbolic link");
        }
        if ($kind !== 'file') {
            return $fail('set.file', "$path: the set file is not a regular file");
        }
        $opened = self::open($path);
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
                    $errors[] = new SetError('set.path', $path, "$path: the $list path " . json_encode($written, self::JSON_QUOTE) . " $wrong");
                    continue;
                }
                $joined = $prefix . $written;
                $error = $this->examine($root, $prefix, $written, $joined, $list === 'external');
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
            $opened = self::open($joined, $identities);
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
        $stat = $follow ? @stat($path) : @lstat($path);
        if ($stat === false) {
            return null;
        }
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
            $this->listings[$dir] = @scandir($dir, SCANDIR_SORT_NONE);
        }
        $listing = $this->listings[$dir];
        return $listing === false ? null : in_array($name, $listing, true);
    }

    /**
     * Opens $path once and reads its bytes and its identity (device and inode of fstat) from that handle.
     * With $identities, a path whose identity is already there is a duplicate and is not read.
     *
     * @param ?array<string, string> $identities the joined path of each identity read so far
     * @return array{string, string}|SetError the identity and the bytes, or the error
     */
    private static function open(string $path, ?array $identities = null): array|SetError
    {
        $failed = static fn(): SetError => new SetError('set.file', $path, "cannot read $path: " . (error_get_last()['message'] ?? 'cannot be read'));
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            return $failed();
        }
        try {
            $stat = @fstat($handle);
            if ($stat === false) {
                return $failed();
            }
            $identity = $stat['dev'] . ':' . $stat['ino'];
            if ($identities !== null && isset($identities[$identity])) {
                return new SetError('set.duplicate', $path, "$path names the same file as {$identities[$identity]}");
            }
            // A failed read of a plain file is a notice and may still return the bytes read before it.
            error_clear_last();
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
     * Step 2: the set file's bytes as JSON. The standard parser checks the syntax, the depth and the
     * escapes; a scan of the checked text, which only checks and parses no value, finds a repeated key in
     * any object and the kind of each top-level value, which the decoded arrays do not keep.
     *
     * @return array{documents: list<string>, external: list<string>}|SetError
     */
    private function parse(string $bytes, string $path): array|SetError
    {
        $error = static fn(string $rule, string $message): SetError => new SetError($rule, $path, "$path: $message");
        if (str_starts_with($bytes, "\xEF\xBB\xBF")) {
            return $error('set.json', 'the set file begins with a byte order mark');
        }
        if (preg_match('//u', $bytes) !== 1) {
            return $error('set.json', 'the set file is not valid UTF-8');
        }
        $value = json_decode($bytes, true, self::DEPTH + 1);
        if (json_last_error() !== JSON_ERROR_NONE) {
            return $error('set.json', 'the set file is not JSON nested at most ' . self::DEPTH . ' levels deep: ' . json_last_error_msg());
        }
        [$top, $members, $repeated] = self::scan($bytes);
        if ($top !== 'object') {
            return $error('set.json', 'the set file is not a JSON object');
        }
        if ($repeated !== null) {
            return $error('set.key', 'the key ' . json_encode($repeated, self::JSON_QUOTE) . ' appears twice');
        }
        $unknown = array_values(array_diff(array_keys($members), ['schema', 'documents', 'external']));
        if ($unknown !== []) {
            $unknown = array_map('strval', $unknown);
            usort($unknown, 'strcmp');
            $quoted = array_map(static fn(string $k): string => (string) json_encode($k, self::JSON_QUOTE), $unknown);
            return $error('set.key', (count($unknown) === 1 ? 'unknown key ' : 'unknown keys ') . implode(', ', $quoted));
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

    /** Whether a top-level value of the kind $kind, decoded as $value, is an array of strings. */
    private static function strings(string $kind, mixed $value): bool
    {
        return $kind === 'array' && array_filter($value, 'is_string') === $value;
    }

    /**
     * Scans JSON text that json_decode accepted: the kind of the top-level value, the kind of each value of
     * the top-level object by its key, and the first key repeated in an object, at any depth.
     *
     * @return array{string, array<string, string>, ?string}
     */
    private static function scan(string $text): array
    {
        $n = strlen($text);
        $top = null;
        $members = [];
        $repeated = null;
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
        return [(string) $top, $members, $repeated];
    }

    /**
     * Why a written path has no normal form, or null when it has one: segments joined by `/`, the last
     * ending in `.dbs`, each a name that every platform can hold; `..` only at the start of an external path.
     */
    private static function normalForm(string $written, string $list): ?string
    {
        $segments = explode('/', $written);
        if (!str_ends_with($segments[count($segments) - 1], '.dbs')) {
            return 'has no normal form';
        }
        $leading = true;
        foreach ($segments as $segment) {
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
            if (!self::segment($segment)) {
                return 'has no normal form';
            }
        }
        return null;
    }

    /** Whether $segment is a name that every platform can hold (docs/dbspec.md "Document sets"). */
    private static function segment(string $segment): bool
    {
        if ($segment === '' || $segment === '.' || preg_match('/[\\\\\/:<>"|?*\x00-\x1F]/', $segment) === 1) {
            return false;
        }
        if (str_ends_with($segment, '.') || str_ends_with($segment, ' ')) {
            return false;
        }
        $dot = strpos($segment, '.');
        $base = strtr(rtrim($dot === false ? $segment : substr($segment, 0, $dot), ' '), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
        return preg_match('/\A(?:CON|PRN|AUX|NUL|(?:COM|LPT)(?:[0-9]|\xC2\xB9|\xC2\xB2|\xC2\xB3))\z/', $base) !== 1;
    }

    /**
     * Step 3 for one path that has its normal form: each prefix of the joined path that ends after a
     * written segment is listed by its directory (a segment other than `..`) and examined with lstat. An
     * intermediate component of an external path that is a link is examined through it (stat).
     */
    private function examine(string $root, string $prefix, string $written, string $joined, bool $external): ?SetError
    {
        $segments = explode('/', $written);
        $last = count($segments) - 1;
        $directory = $root;
        $component = $prefix;
        foreach ($segments as $i => $segment) {
            $component .= ($i === 0 ? '' : '/') . $segment;
            if ($segment !== '..') {
                $listed = $this->lists($directory, $segment);
                if ($listed === null) {
                    return new SetError('set.file', $joined, "$joined: the directory $directory cannot be listed");
                }
                if (!$listed) {
                    return new SetError('set.file', $joined, "$joined: $segment is not a name that $directory lists");
                }
            }
            $kind = $this->kind($component);
            if ($kind === 'link' && $external && $i < $last) {
                $kind = $this->kind($component, true);
            }
            if ($kind === null) {
                return new SetError('set.file', $joined, "$joined: $component cannot be examined");
            }
            if ($kind === 'link') {
                return new SetError('set.symlink', $joined, "$joined: $component is a symbolic link");
            }
            if ($i < $last && $kind !== 'dir') {
                return new SetError('set.file', $joined, "$joined: $component is not a directory");
            }
            if ($i === $last && $kind !== 'file') {
                return new SetError('set.file', $joined, "$joined: $component is not a regular file");
            }
            $directory = $component;
        }
        return null;
    }
}
