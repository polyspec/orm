<?php
// orm-gen command line test: gen writes and checks the models of a dbspec
// document set.
// Usage: php packages/orm-php/tests/orm_gen_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

use Polyspec\Orm\OrmGen;

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

/** Writes the set file of $documents and $external into $dir. */
function set_file(string $dir, array $documents, array $external = []): string
{
    @mkdir($dir, 0o700, true);
    $path = "$dir/dbspec-set.json";
    file_put_contents($path, json_encode(['schema' => 1, 'documents' => $documents, 'external' => $external], JSON_UNESCAPED_SLASHES));
    return $path;
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
    $set = set_file($dir, ['example.dbs']);
    $args = ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--check'];
    [$code] = tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
    check($code === 0, 'gen');
    file_put_contents("$dir/model/Notes.php", "<?php\n");
    [$code, $out, $err] = tool($args);
    check($code === 0 && $out === '' && $err === '', "current: $code $out $err");
    file_put_contents("$dir/model/Item.php", "<?php\n");
    unlink("$dir/model/Tag.php");
    file_put_contents("$dir/model/Removed.php", "<?php\n" . \Polyspec\Orm\Generator::MARKER . "\n");
    $before = array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php"));
    [$code, $out] = tool($args);
    check($code === 1 && $out === "differs: $dir/model/Item.php\nextra: $dir/model/Removed.php\nmissing: $dir/model/Tag.php\n", "differences: $code $out");
    check(array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php")) === $before, 'gen --check wrote files');
};

$tests['gen rejects a file without the dbspec signature'] = function () use ($work): void {
    // The byte check rejects the DbSchema project XML and the empty file before the parse, and every
    // file's diagnostic is printed.
    $set = set_file("$work/signature", ['dbschema.dbs', 'empty.dbs']);
    foreach (['dbschema.dbs', 'empty.dbs'] as $name) {
        copy(dirname(__DIR__, 3) . "/tests/dbspec/files/$name", "$work/signature/$name");
    }
    $dir = "$work/signature/model";
    [$code, $out, $err] = tool(['gen', '--set', $set, '--out', $dir, '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
    $want = "orm-gen: SCHEMA_INVALID: $work/signature/dbschema.dbs:1:1: signature: $work/signature/dbschema.dbs is not a dbspec document\n"
        . "$work/signature/empty.dbs:1:1: signature: $work/signature/empty.dbs is not a dbspec document\n";
    check($code === 1 && $out === '' && $err === $want, "$code $out $err");
    check(!file_exists($dir), "gen wrote $dir");
};

$tests['gen prints every error of the set file and writes nothing'] = function () use ($work): void {
    $dir = "$work/set-errors";
    $set = set_file($dir, ['gone.dbs', 'sub\\x.dbs']);
    [$code, $out, $err] = tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
    $want = "orm-gen: CONFIG: set.file: $dir/gone.dbs: gone.dbs is not a name that $dir/ lists\n"
        . "set.path: $set: the documents path \"sub\\\\x.dbs\" has no normal form\n";
    check($code === 1 && $out === '' && $err === $want, "$code $out $err");
    check(!file_exists("$dir/model"), 'gen wrote the models');
};

$tests['gen takes the documents only from the set file'] = function () use ($work): void {
    $dir = "$work/positional";
    $set = set_file($dir, ['example.dbs']);
    file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  primary key (seq)\n}\n");
    foreach ([['--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"], ['--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"], ['--set', $set, '--use', "$dir/example.dbs", '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']] as $args) {
        [$code, $out, $err] = tool(['gen', ...$args]);
        check($code === 2 && $out === '' && str_contains($err, 'usage: orm-gen gen --set '), json_encode($args) . ": $code $out $err");
    }
    check(!file_exists("$dir/model"), 'gen wrote the models');
};

$tests['gen rejects a column named after a model method'] = function () use ($work): void {
    // restore()는 모든 model의 method이므로 restore column의 condition method와 겹친다.
    $dir = "$work/gen-reserved";
    @mkdir("$dir/model", 0o700, true);
    $set = set_file($dir, ['example.dbs']);
    foreach (['create', 'restore'] as $column) {
        file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  $column varchar(32)\n  primary key (seq)\n}\n");
        [$code, $out, $err] = tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
        check($code !== 0 && str_contains($out . $err, "column name is a reserved method name: $column"), "$column: $code $out $err");
    }
};

$tests['gen generates only the owned tables of a set with external documents'] = function () use ($work): void {
    // member.dbs uses ext_account and ext_audit of core.dbs. core is an external document of the set, so it
    // gets no model, and the bootstrap holds the text of the external tables that are used.
    $root = dirname(__DIR__, 3);
    $dir = "$work/gen-use";
    $set = set_file("$dir/set/app", ['member.dbs'], ['../core/core.dbs']);
    @mkdir("$dir/set/core", 0o700, true);
    copy("$root/contracts/fixtures/external/member.dbs", "$dir/set/app/member.dbs");
    copy("$root/contracts/fixtures/external/core.dbs", "$dir/set/core/core.dbs");
    [$code, $out, $err] = tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
    check($code === 0, "gen: $code $out $err");
    $files = array_map('basename', glob("$dir/model/*.php") ?: []);
    sort($files);
    check($files === ['ExtPost.php', 'ExtPostHistory.php', 'bootstrap.php'], 'generated files ' . json_encode($files));
    $bootstrap = (string) @file_get_contents("$dir/model/bootstrap.php");
    check(str_contains($bootstrap, 'const EXTERNAL_TEXT = ') && str_contains($bootstrap, 'table ext_account {') && !str_contains($bootstrap, 'table ext_session {'), 'bootstrap carries the used external tables');
    [$code, $out] = tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--check']);
    check($code === 0 && $out === '', "gen --check with external documents: $code $out");
};

$tests['gen writes the same models however the paths are written'] = function () use ($work): void {
    // The PHP generator scans no source, so only the set and output paths are written relative, absolute,
    // with `./` and with a trailing `/` (the output only: a set path ends in its file name).
    $dir = "$work/gen-path-spelling";
    set_file($dir, ['example.dbs']);
    file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n");
    $spellings = [
        'relative' => ['dbspec-set.json', 'model'],
        'absolute' => ["$dir/dbspec-set.json", "$dir/model"],
        'dot' => ['./dbspec-set.json', './model'],
        'trailing_slash' => ['dbspec-set.json', 'model/'],
    ];
    $previous = getcwd();
    chdir($dir);
    try {
        $first = null;
        foreach ($spellings as $name => [$set, $out]) {
            exec('rm -rf ' . escapeshellarg("$dir/model"));
            [$code, , $err] = tool(['gen', '--set', $set, '--out', $out, '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
            check($code === 0, "$name: $code $err");
            $files = [];
            foreach (glob("$dir/model/*.php") as $file) {
                $files[basename($file)] = file_get_contents($file);
            }
            $first ??= $files;
            check($files !== [] && $files === $first, "the models of the $name paths differ from the relative paths");
        }
    } finally {
        chdir($previous);
    }
};

$tests['gen is the only command'] = function (): void {
    foreach (['build', 'ddl', 'diff', 'validate', 'migrate', 'import'] as $command) {
        [$code, $out, $err] = tool([$command]);
        check($code === 2 && $out === '' && str_starts_with($err, "usage: orm-gen gen ") && substr_count($err, "\n") === 1, "$command: $code $out $err");
    }
};

/** Runs $command in a new process from the repository root and returns its exit code, stdout and stderr. */
function process(array $command): array
{
    $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, dirname(__DIR__, 3));
    $out = (string) stream_get_contents($pipes[1]);
    $err = (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    return [proc_close($process), $out, $err];
}

$tests['the bin Composer installs loads the autoloader'] = function (): void {
    [$code, $out, $err] = process([PHP_BINARY, 'vendor-php/bin/orm-gen']);
    check($code === 2 && $out === '' && str_starts_with($err, 'usage: orm-gen gen '), "vendor-php/bin/orm-gen: $code $out $err");
};

$tests['the bin outside Composer names the missing autoloader'] = function (): void {
    [$code, $out, $err] = process([PHP_BINARY, 'packages/orm-php/bin/orm-gen']);
    $missing = dirname(__DIR__) . '/bin/../vendor/autoload.php';
    check($code === 2 && $out === '' && $err === "orm-gen: no Composer autoloader at $missing; run the vendor/bin/orm-gen that Composer installs\n", "packages/orm-php/bin/orm-gen: $code $out $err");
};

// Each case runs orm-gen in this process and writes and reads models in a temporary directory,
// except the bin cases, which run the bin in a new process.
foreach ($tests as $current => $test) {
    $before = $failures;
    $passed = testcase_run("orm_gen/$current", TESTCASE_COMPUTE, static function () use ($test, $before): void {
        $test();
        if ($GLOBALS['failures'] > $before) {
            throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
        }
    });
    if (!$passed && $failures === $before) {
        $failures++;
    }
}
if ($failures > 0) {
    exit(1);
}
