<?php
declare(strict_types=1);

// The extension's set reader (Polyspec\Orm\Dbspec\Native\Dbspec::readSet) against the shared vectors
// tests/dbspec/set-files.json and the focused cases, each in a temporary file tree with real symbolic and hard
// links. The PHP client is the specification, so on every tree the native result equals the PHP client's: the
// same files and bytes, or the same errors with their rules, paths and messages. The result classes follow the
// PHP client's rules too (SetResult::invalid without an error).
//
// Usage: php -d extension=<orm_dbspec library> packages/php-ext/tests/dbspec_set_test.php

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;

$root = dirname(__DIR__, 3);
require "$root/packages/php/tests/autoload.php";
require "$root/packages/php/tests/dbspec_set_cases.php";
require_once "$root/tests/testcase.php";

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it\n");
    exit(1);
}

/** The outcome of $body as [class without namespace, value or message]. */
function set_outcome(callable $body): array
{
    try {
        $value = $body();
        return [is_object($value) ? substr(strrchr('\\' . get_class($value), '\\'), 1) : 'value', json_encode($value instanceof stdClass ? $value : (is_object($value) ? dbspec_set_described($value) : $value), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)];
    } catch (Throwable $error) {
        return [get_class($error), $error->getMessage()];
    }
}

$count = dbspec_set_run($root, 'dbspec_set_extension', static fn(string $path): object => NativeDbspec::readSet($path), static function (object $native, string $path): void {
    $php = dbspec_set_described(Dbspec::readSet($path));
    $got = dbspec_set_described($native);
    if ($got !== $php) {
        throw new RuntimeException('the extension differs from the PHP client: want ' . json_encode($php, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . ', got ' . json_encode($got, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
    }
    foreach ([$native->documents ?? [], $native->external ?? []] as $files) {
        foreach ($files as $file) {
            if (!$file instanceof Polyspec\Orm\Dbspec\Native\SetFile) {
                throw new RuntimeException('a file is not a Native\SetFile');
            }
        }
    }
    foreach ($native->errors as $error) {
        if (!$error instanceof Polyspec\Orm\Dbspec\Native\SetError) {
            throw new RuntimeException('an error is not a Native\SetError');
        }
    }
});

$work = sys_get_temp_dir() . '/orm-php-dbspec-set-extension-' . getmypid();
mkdir("$work/cwd", 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});
file_put_contents("$work/cwd/shop.dbs", "dbspec 1 shop\n");
file_put_contents("$work/cwd/dbspec-set.json", '{"schema": 1, "documents": ["shop.dbs"]}');
$inCwd = static function (callable $read) use ($work): object {
    $previous = getcwd();
    chdir("$work/cwd");
    try {
        return $read('dbspec-set.json');
    } finally {
        chdir($previous);
    }
};
$classes = [
    'a set path without a directory' => [
        static fn() => $inCwd(static fn(string $p): object => Dbspec::readSet($p)),
        static fn() => $inCwd(static fn(string $p): object => NativeDbspec::readSet($p)),
    ],
    'a set path with a NUL byte' => [
        static fn() => Dbspec::readSet("$work/a\0b/dbspec-set.json"),
        static fn() => NativeDbspec::readSet("$work/a\0b/dbspec-set.json"),
    ],
    'SetResult::invalid without an error' => [
        static fn() => Polyspec\Orm\Dbspec\SetResult::invalid([]),
        static fn() => Polyspec\Orm\Dbspec\Native\SetResult::invalid([]),
    ],
    'SetResult::invalid' => [
        static fn() => Polyspec\Orm\Dbspec\SetResult::invalid([new Polyspec\Orm\Dbspec\SetError('set.file', 'a', 'a: m')]),
        static fn() => Polyspec\Orm\Dbspec\Native\SetResult::invalid([new Polyspec\Orm\Dbspec\Native\SetError('set.file', 'a', 'a: m')]),
    ],
    'SetResult::valid' => [
        static fn() => Polyspec\Orm\Dbspec\SetResult::valid([new Polyspec\Orm\Dbspec\SetFile('a.dbs', 'x')], []),
        static fn() => Polyspec\Orm\Dbspec\Native\SetResult::valid([new Polyspec\Orm\Dbspec\Native\SetFile('a.dbs', 'x')], []),
    ],
];
foreach ($classes as $name => [$php, $native]) {
    $ok = testcase_run("dbspec_set_extension/classes/$name", TESTCASE_COMPUTE, static function () use ($php, $native): void {
        $want = set_outcome($php);
        $got = set_outcome($native);
        if ($want !== $got) {
            throw new RuntimeException('want ' . json_encode($want) . ', got ' . json_encode($got));
        }
    });
    if (!$ok) {
        exit(1);
    }
}
echo "dbspec set extension: $count cases equal to the PHP client, " . count($classes) . " other cases\n";
