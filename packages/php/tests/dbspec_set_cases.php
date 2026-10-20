<?php

declare(strict_types=1);

use PHPUnit\Framework\Assert;

// The set reader vectors (tests/dbspec/set-files.json, docs/spec/dbspec.md "Document sets"), shared by the PHP
// client test and the extension test. The vector file is read strictly: an unknown or missing field is an
// error, and every case runs.

/** Fails with $message when the keys of $value are not exactly $keys. */
function dbspec_set_keys(string $what, mixed $value, array $keys): void
{
    if (!is_array($value) || array_is_list($value) && $value !== []) {
        throw new RuntimeException("$what is not an object");
    }
    $got = array_map('strval', array_keys($value));
    sort($got);
    sort($keys);
    if ($got !== $keys) {
        throw new RuntimeException("$what has the fields " . json_encode($got) . ', want ' . json_encode($keys));
    }
}

/**
 * The cases of set-files.json, checked field by field.
 *
 * @return list<array{id: string, tree: array<string, array<string, string>>, set: string, want: array<string, mixed>}>
 */
function dbspec_set_cases(string $root): array
{
    $file = json_decode((string) file_get_contents("$root/tests/dbspec/set-files.json"), true, 512, JSON_THROW_ON_ERROR);
    dbspec_set_keys('set-files.json', $file, ['requirements', 'version', 'note', 'cases']);
    if ($file['version'] !== 1 || !is_string($file['note']) || !is_array($file['cases']) || !array_is_list($file['cases']) || $file['cases'] === []) {
        throw new RuntimeException('set-files.json: version, note or cases is wrong');
    }
    $ids = [];
    foreach ($file['cases'] as $i => $case) {
        dbspec_set_keys("case $i", $case, ['id', 'tree', 'set', 'want']);
        if (!is_string($case['id']) || isset($ids[$case['id']]) || !is_string($case['set']) || !is_array($case['tree']) || $case['tree'] === [] || array_is_list($case['tree'])) {
            throw new RuntimeException("case $i: id, set or tree is wrong");
        }
        $ids[$case['id']] = true;
        foreach ($case['tree'] as $path => $entry) {
            if (!is_array($entry) || count($entry) !== 1 || !in_array(array_key_first($entry), ['file', 'hex', 'symlink', 'hardlink'], true) || !is_string(reset($entry))) {
                throw new RuntimeException("{$case['id']}: tree entry $path is not one of file, hex, symlink and hardlink");
            }
        }
        $want = $case['want'];
        if (is_array($want) && array_key_exists('errors', $want)) {
            dbspec_set_keys("{$case['id']}: want", $want, ['errors']);
            if (!is_array($want['errors']) || !array_is_list($want['errors']) || $want['errors'] === []) {
                throw new RuntimeException("{$case['id']}: want errors is not a non-empty list");
            }
            foreach ($want['errors'] as $j => $error) {
                dbspec_set_keys("{$case['id']}: error $j", $error, ['rule', 'path']);
                if (!is_string($error['rule']) || !is_string($error['path'])) {
                    throw new RuntimeException("{$case['id']}: error $j is not strings");
                }
            }
        } else {
            dbspec_set_keys("{$case['id']}: want", $want, ['documents', 'external']);
            foreach (['documents', 'external'] as $list) {
                if (!is_array($want[$list]) || !array_is_list($want[$list]) || array_filter($want[$list], 'is_string') !== $want[$list]) {
                    throw new RuntimeException("{$case['id']}: want $list is not a list of strings");
                }
            }
        }
    }
    return $file['cases'];
}

/**
 * Builds the tree of a case under the empty directory $dir with real symbolic and hard links, and returns
 * the bytes of each file by its tree path (a hard link has the bytes of its target).
 *
 * @return array<string, string>
 */
function dbspec_set_tree(string $dir, array $tree): array
{
    $bytes = [];
    $links = [];
    foreach ($tree as $path => $entry) {
        $path = (string) $path;
        $target = "$dir/$path";
        $parent = dirname($target);
        if (!is_dir($parent) && !mkdir($parent, 0o700, true)) {
            throw new RuntimeException("cannot create $parent");
        }
        $kind = array_key_first($entry);
        $value = $entry[$kind];
        $ok = match ($kind) {
            'file' => file_put_contents($target, $value) === strlen($value),
            'hex' => file_put_contents($target, (string) hex2bin($value)) === strlen($value) / 2,
            'symlink' => symlink($value, $target),
            'hardlink' => link("$dir/$value", $target),
        };
        if (!$ok) {
            throw new RuntimeException("cannot create the $kind $target");
        }
        match ($kind) {
            'file' => $bytes[$path] = $value,
            'hex' => $bytes[$path] = (string) hex2bin($value),
            'hardlink' => $bytes[$path] = $bytes[$value] ?? throw new RuntimeException("hard link $path names no earlier file $value"),
            'symlink' => $links[$path] = dbspec_set_resolve(dirname($path) . '/' . $value),
        };
    }
    // A file reached through a symbolic link to a directory is also listed under the link's tree path.
    foreach ($links as $link => $target) {
        foreach ($bytes as $file => $content) {
            if (str_starts_with($file, "$target/")) {
                $bytes[$link . substr($file, strlen($target))] = $content;
            }
        }
    }
    return $bytes;
}

/** The tree path that a path names, its `.` and `..` segments resolved lexically. */
function dbspec_set_resolve(string $path): string
{
    $out = [];
    foreach (explode('/', $path) as $segment) {
        if ($segment === '..') {
            array_pop($out);
        } elseif ($segment !== '.' && $segment !== '') {
            $out[] = $segment;
        }
    }
    return implode('/', $out);
}

/** A result of a set reader described for comparison: the files with their bytes, or the errors. */
function dbspec_set_described(object $result): array
{
    $files = static fn(?array $list): ?array => $list === null ? null : array_map(static fn(object $f): array => [$f->path, $f->bytes], $list);
    return [
        'documents' => $files($result->documents),
        'external' => $files($result->external),
        'errors' => array_map(static fn(object $e): array => [$e->rule, $e->path, $e->message], $result->errors),
    ];
}

/**
 * The data sets of the vector cases of tests/dbspec/set-files.json, named by their case ids, each holding [case]. A
 * repeated id is an error.
 *
 * @return iterable<string, array{array<string, mixed>}>
 */
function dbspec_set_sets(string $root): iterable
{
    return dbspec_set_named(dbspec_set_cases($root));
}

/**
 * The data sets of the focused cases, named by their ids, each holding [case]. A repeated id is an error.
 *
 * @return iterable<string, array{array<string, mixed>}>
 */
function dbspec_set_focused_sets(): iterable
{
    return dbspec_set_named(dbspec_set_focused());
}

/** @return iterable<string, array{array<string, mixed>}> */
function dbspec_set_named(iterable $cases): iterable
{
    $seen = [];
    foreach ($cases as $case) {
        Assert::assertFalse(isset($seen[$case['id']]), "repeated set case id {$case['id']}");
        $seen[$case['id']] = true;
        yield $case['id'] => [$case];
    }
}

/**
 * Cases in the vector format for readings the vectors do not state: a repeated key inside a nested
 * object is a set.key error before schema is judged, an object is not an array even when its keys are
 * indexes, and a string inside a nested array is not a key.
 *
 * @return list<array<string, mixed>>
 */
function dbspec_set_focused(): array
{
    $shop = ['file' => "dbspec 1 shop\n"];
    $set = static fn(string $json): array => ['app/shop.dbs' => $shop, 'app/dbspec-set.json' => ['file' => $json]];
    $error = static fn(string $rule): array => ['errors' => [['rule' => $rule, 'path' => 'app/dbspec-set.json']]];
    return [
        ['id' => 'nested-key-twice', 'tree' => $set('{"schema": {"a": 1, "a": 2}, "documents": ["shop.dbs"]}'), 'set' => 'app/dbspec-set.json', 'want' => $error('set.key')],
        ['id' => 'documents-object', 'tree' => $set('{"schema": 1, "documents": {"0": "shop.dbs"}}'), 'set' => 'app/dbspec-set.json', 'want' => $error('set.key')],
        ['id' => 'documents-empty-object', 'tree' => $set('{"schema": 1, "documents": {}}'), 'set' => 'app/dbspec-set.json', 'want' => $error('set.key')],
        ['id' => 'escaped-key-twice', 'tree' => $set('{"schema": 1, "documents": ["shop.dbs"], "docum\\u0065nts": ["shop.dbs"]}'), 'set' => 'app/dbspec-set.json', 'want' => $error('set.key')],
        ['id' => 'nested-strings-are-values', 'tree' => $set('{"schema": 1, "documents": ["shop.dbs"], "x": [{"a": ["a", "a"]}, {"a": 1}]}'), 'set' => 'app/dbspec-set.json', 'want' => $error('set.key')],
        ['id' => 'schema-ten-tenths', 'tree' => $set('{"schema": 10E-1, "documents": ["shop.dbs"]}'), 'set' => 'app/dbspec-set.json', 'want' => ['documents' => ['app/shop.dbs'], 'external' => []]],
        ['id' => 'top-level-string', 'tree' => $set('"x"'), 'set' => 'app/dbspec-set.json', 'want' => $error('set.json')],
        ['id' => 'empty-file', 'tree' => $set(''), 'set' => 'app/dbspec-set.json', 'want' => $error('set.json')],
    ];
}

/**
 * Runs one case through $read(path) in a temporary file tree of its own and compares it with the vector, with the
 * PHPUnit assertions; $also(result, path) may add its own comparison (the extension test compares with the PHP
 * client).
 */
function dbspec_set_check(array $case, callable $read, ?callable $also = null): void
{
    $dir = sys_get_temp_dir() . '/orm-php-dbspec-set-' . getmypid() . '-' . md5($case['id'] . json_encode($case['tree']));
    if (!mkdir($dir, 0o700, true)) {
        throw new RuntimeException("cannot create $dir");
    }
    try {
        $bytes = dbspec_set_tree($dir, $case['tree']);
        $path = "$dir/{$case['set']}";
        $result = $read($path);
        $got = dbspec_set_described($result);
        $want = $case['want'];
        if (isset($want['errors'])) {
            $expected = array_map(static fn(array $e): array => [$e['rule'], "$dir/{$e['path']}"], $want['errors']);
            $rules = array_map(static fn(array $e): array => [$e[0], $e[1]], $got['errors']);
            $detail = 'want errors ' . json_encode($expected, JSON_UNESCAPED_SLASHES) . ', got ' . json_encode($got, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
            Assert::assertNull($got['documents'], $detail);
            Assert::assertNull($got['external'], $detail);
            Assert::assertSame($expected, $rules, $detail);
            foreach ($got['errors'] as [, $errorPath, $message]) {
                Assert::assertTrue(str_contains($message, $errorPath), "the message \"$message\" does not name $errorPath");
            }
        } else {
            $expected = [];
            foreach (['documents', 'external'] as $list) {
                $expected[$list] = array_map(static function (string $p) use ($dir, $bytes): array {
                    // A joined path such as app/../core/core.dbs names the tree file core/core.dbs.
                    $parts = [];
                    foreach (explode('/', $p) as $segment) {
                        if ($segment === '..') {
                            array_pop($parts);
                        } else {
                            $parts[] = $segment;
                        }
                    }
                    return ["$dir/$p", $bytes[implode('/', $parts)] ?? throw new RuntimeException("the vector lists $p, which is no tree file")];
                }, $want[$list]);
            }
            $expected['errors'] = [];
            Assert::assertSame($expected, $got, 'want ' . json_encode($expected, JSON_UNESCAPED_SLASHES) . ', got ' . json_encode($got, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
        }
        if ($also !== null) {
            $also($result, $path);
        }
    } finally {
        exec('rm -rf ' . escapeshellarg($dir));
    }
}
