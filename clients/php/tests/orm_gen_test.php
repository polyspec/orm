<?php
// orm-gen command line test: gen writes and checks the models of a dbspec
// document set.
// Usage: php clients/php/tests/orm_gen_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\OrmGen;

$work = sys_get_temp_dir() . '/orm-php-orm-gen-' . getmypid();
@mkdir($work, 0o700, true);
register_shutdown_function(static function () use ($work): void {
    exec('rm -rf ' . escapeshellarg($work));
});

$failures = 0;
$tests = [];

function check(bool $ok, string $message): void
{
    global $failures, $current;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $message\n");
    }
}

function tool(array $args): array
{
    ob_start();
    $stderr = fopen('php://memory', 'w+');
    $code = OrmGen::run($args, $stderr);
    $out = (string) ob_get_clean();
    rewind($stderr);
    return [$code, $out, (string) stream_get_contents($stderr)];
}

$tests['gen --check compares the models without writing'] = function () use ($work): void {
    $dir = "$work/gen-check";
    @mkdir("$dir/model", 0o700, true);
    file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n\ntable tag {\n  seq i64\n  primary key (seq)\n}\n");
    $args = ['gen', '--out', "$dir/model", '--namespace', 'Example\\Model', '--check', "$dir/example.dbs"];
    [$code] = tool(['gen', '--out', "$dir/model", '--namespace', 'Example\\Model', "$dir/example.dbs"]);
    check($code === 0, 'gen');
    file_put_contents("$dir/model/Notes.php", "<?php\n");
    [$code, $out, $err] = tool($args);
    check($code === 0 && $out === '' && $err === '', "current: $code $out $err");
    file_put_contents("$dir/model/Item.php", "<?php\n");
    unlink("$dir/model/Tag.php");
    file_put_contents("$dir/model/Removed.php", "<?php\n" . \Orm\Generator::MARKER . "\n");
    $before = array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php"));
    [$code, $out] = tool($args);
    check($code === 1 && $out === "differs: $dir/model/Item.php\nextra: $dir/model/Removed.php\nmissing: $dir/model/Tag.php\n", "differences: $code $out");
    check(array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php")) === $before, 'gen --check wrote files');
};

$tests['gen rejects a file without the dbspec signature'] = function () use ($work): void {
    // Dbspec::readFile이 parse 전에 DbSchema project XML과 빈 파일을 signature로 거부한다.
    foreach (['dbschema.dbs', 'empty.dbs'] as $name) {
        $path = dirname(__DIR__, 3) . "/tests/dbspec/files/$name";
        $dir = "$work/signature-$name";
        [$code, $out, $err] = tool(['gen', '--out', $dir, '--namespace', 'Example\\Model', $path]);
        check($code === 1 && $out === '' && $err === "orm-gen: SCHEMA_INVALID: $path:1:1: signature: $path is not a dbspec document\n", "$name: $code $out $err");
        check(!file_exists($dir), "$name: gen wrote $dir");
    }
};

$tests['gen is the only command'] = function (): void {
    foreach (['build', 'ddl', 'diff', 'validate', 'migrate', 'import'] as $command) {
        [$code, $out, $err] = tool([$command]);
        check($code === 2 && $out === '' && str_starts_with($err, "usage: orm-gen gen ") && substr_count($err, "\n") === 1, "$command: $code $out $err");
    }
};

foreach ($tests as $current => $test) {
    try {
        $test();
    } catch (Throwable $e) {
        $failures++;
        fwrite(STDERR, "FAIL $current: $e\n");
    }
    echo ($failures === 0 ? 'ok   ' : '...  ') . "$current\n";
}
if ($failures > 0) {
    fwrite(STDERR, "php orm-gen test: $failures failures\n");
    exit(1);
}
echo 'php orm-gen test: ' . count($tests) . " tests passed\n";
