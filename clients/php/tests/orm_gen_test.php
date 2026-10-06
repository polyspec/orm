<?php
// orm-gen command line test: gen writes and checks the models of a dbspec
// document set.
// Usage: php clients/php/tests/orm_gen_test.php
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
    $args = ['gen', '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--check', "$dir/example.dbs"];
    [$code] = tool(['gen', '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"]);
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
    // Dbspec::readFile이 parse 전에 DbSchema project XML과 빈 파일을 signature로 거부한다.
    foreach (['dbschema.dbs', 'empty.dbs'] as $name) {
        $path = dirname(__DIR__, 3) . "/tests/dbspec/files/$name";
        $dir = "$work/signature-$name";
        [$code, $out, $err] = tool(['gen', '--out', $dir, '--namespace', 'Polyspec\\Orm\\Tests\\Example', $path]);
        check($code === 1 && $out === '' && $err === "orm-gen: SCHEMA_INVALID: $path:1:1: signature: $path is not a dbspec document\n", "$name: $code $out $err");
        check(!file_exists($dir), "$name: gen wrote $dir");
    }
};

$tests['gen rejects a column named after a model method'] = function () use ($work): void {
    // restore()는 모든 model의 method이므로 restore column의 condition method와 겹친다.
    $dir = "$work/gen-reserved";
    @mkdir("$dir/model", 0o700, true);
    foreach (['create', 'restore'] as $column) {
        file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  $column varchar(32)\n  primary key (seq)\n}\n");
        [$code, $out, $err] = tool(['gen', '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"]);
        check($code !== 0 && str_contains($out . $err, "column name is a reserved method name: $column"), "$column: $code $out $err");
    }
};

$tests['gen --use generates only the owned tables of a set with external documents'] = function () use ($work): void {
    // member.dbs는 core.dbs의 ext_account와 ext_audit을 use로 쓴다. core는 --use로 주는 외부 문서이므로
    // model을 만들지 않고, bootstrap은 외부 문서에서 쓰는 table의 text를 담는다.
    $root = dirname(__DIR__, 3);
    $dir = "$work/gen-use";
    @mkdir($dir, 0o700, true);
    [$code, $out, $err] = tool(['gen', '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--use', "$root/contracts/fixtures/external/core.dbs", "$root/contracts/fixtures/external/member.dbs"]);
    check($code === 0, "gen: $code $out $err");
    $files = array_map('basename', glob("$dir/model/*.php") ?: []);
    sort($files);
    check($files === ['ExtPost.php', 'ExtPostHistory.php', 'bootstrap.php'], 'generated files ' . json_encode($files));
    $bootstrap = (string) @file_get_contents("$dir/model/bootstrap.php");
    check(str_contains($bootstrap, 'const EXTERNAL_TEXT = ') && str_contains($bootstrap, 'table ext_account {') && !str_contains($bootstrap, 'table ext_session {'), 'bootstrap carries the used external tables');
    [$code, $out] = tool(['gen', '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--check', '--use', "$root/contracts/fixtures/external/core.dbs", "$root/contracts/fixtures/external/member.dbs"]);
    check($code === 0 && $out === '', "gen --check with --use: $code $out");
};

$tests['gen writes the same models however the paths are written'] = function () use ($work): void {
    // PHP 생성기는 소스를 scan하지 않으므로 document와 output path만 상대, 절대, `./`, 끝의 `/`로 바꿔 쓴다.
    $dir = "$work/gen-path-spelling";
    @mkdir($dir, 0o700, true);
    file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n");
    $spellings = [
        'relative' => ['example.dbs', 'model'],
        'absolute' => ["$dir/example.dbs", "$dir/model"],
        'dot' => ['./example.dbs', './model'],
        'trailing_slash' => ['example.dbs', 'model/'],
    ];
    $previous = getcwd();
    chdir($dir);
    try {
        $first = null;
        foreach ($spellings as $name => [$document, $out]) {
            exec('rm -rf ' . escapeshellarg("$dir/model"));
            [$code, , $err] = tool(['gen', '--out', $out, '--namespace', 'Polyspec\\Orm\\Tests\\Example', $document]);
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

// 각 case는 orm-gen을 같은 process에서 실행해 임시 directory에 models를 쓰고 읽는다.
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
