<?php
declare(strict_types=1);
// The set reader Dbspec::readSet (docs/dbspec.md "Document sets") through the shared vectors
// tests/dbspec/set-files.json and the cases they cannot state: a set path without a directory, whose root
// is the working directory, and a set path with a NUL byte.
// Usage: php packages/orm-php/tests/dbspec_set_test.php
require __DIR__ . '/autoload.php';
require __DIR__ . '/dbspec_set_cases.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\Dbspec\Dbspec;

$root = dirname(__DIR__, 3);
$count = dbspec_set_run($root, 'dbspec_set', static fn(string $path): object => Dbspec::readSet($path));

$work = sys_get_temp_dir() . '/orm-php-dbspec-set-focused-' . getmypid();
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});
$focused = [
    'a set path without a directory reads from the working directory' => static function () use ($work): void {
        mkdir("$work/cwd", 0o700, true);
        file_put_contents("$work/cwd/shop.dbs", "dbspec 1 shop\n");
        file_put_contents("$work/cwd/dbspec-set.json", '{"schema": 1, "documents": ["shop.dbs"]}');
        $previous = getcwd();
        chdir("$work/cwd");
        try {
            $result = Dbspec::readSet('dbspec-set.json');
        } finally {
            chdir($previous);
        }
        if ($result->errors !== [] || count($result->documents) !== 1 || $result->documents[0]->path !== 'shop.dbs' || $result->documents[0]->bytes !== "dbspec 1 shop\n" || $result->external !== []) {
            throw new RuntimeException('got ' . json_encode(dbspec_set_described($result)));
        }
    },
    'a set path with a NUL byte is a set.file error' => static function () use ($work): void {
        $path = "$work/a\0b/dbspec-set.json";
        $result = Dbspec::readSet($path);
        $got = array_map(static fn(object $e): array => [$e->rule, $e->path], $result->errors);
        if ($result->documents !== null || $got !== [['set.file', $path]]) {
            throw new RuntimeException('got ' . json_encode($got));
        }
    },
];
foreach ($focused as $name => $body) {
    if (!testcase_run("dbspec_set/$name", TESTCASE_COMPUTE, $body)) {
        exit(1);
    }
}
echo "dbspec set: $count vector and focused set cases, " . count($focused) . " path cases\n";
