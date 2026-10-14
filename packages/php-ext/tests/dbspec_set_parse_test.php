<?php
declare(strict_types=1);

// The extension's set parse (Polyspec\Orm\Dbspec\Native\Dbspec::parseSet) against the shared vectors
// tests/dbspec/set-parse.json. The PHP client is the specification, so on every case the native result equals the
// PHP client's: the same names, external marks, documents, positions and diagnostics, and the same set diagnostics.
//
// Usage: php -d extension=<orm_dbspec library> packages/php-ext/tests/dbspec_set_parse_test.php

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;

$root = dirname(__DIR__, 3);
require "$root/packages/php/tests/autoload.php";
require "$root/packages/php/tests/dbspec_set_parse_cases.php";
require_once "$root/tests/testcase.php";

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it\n");
    exit(1);
}

$count = dbspec_set_parse_run($root, 'dbspec_set_parse_extension', static fn(array $owned, array $external): array => NativeDbspec::parseSet($owned, $external), static function (array $native, array $case): void {
    $want = dbspec_set_parse_described(Dbspec::parseSet($case['owned'], $case['external']));
    $got = dbspec_set_parse_described($native);
    if ($got !== $want) {
        throw new RuntimeException('the extension differs from the PHP client: want ' . json_encode($want, JSON_UNESCAPED_SLASHES) . ', got ' . json_encode($got, JSON_UNESCAPED_SLASHES));
    }
});
echo "dbspec set parse extension: $count vector cases\n";
