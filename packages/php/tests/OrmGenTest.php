<?php
// orm-gen command line test: gen writes and checks the models of a dbspec
// document set.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmGen;

// Each case runs orm-gen in this process and writes and reads models in a temporary directory,
// except the bin cases, which run the bin in a new process.
#[Small]
final class OrmGenTest extends TestCase
{
    private static string $work;

    public static function setUpBeforeClass(): void
    {
        self::$work = sys_get_temp_dir() . '/orm-php-orm-gen-' . getmypid();
        @mkdir(self::$work, 0o700, true);
    }

    public static function tearDownAfterClass(): void
    {
        exec('rm -rf ' . escapeshellarg(self::$work));
    }

    /** Writes the set file of $documents and $external into $dir. */
    private static function setFile(string $dir, array $documents, array $external = []): string
    {
        @mkdir($dir, 0o700, true);
        $path = "$dir/dbspec-set.json";
        file_put_contents($path, json_encode(['schema' => 1, 'documents' => $documents, 'external' => $external], JSON_UNESCAPED_SLASHES));
        return $path;
    }

    private static function tool(array $args): array
    {
        ob_start();
        $stderr = fopen('php://memory', 'w+');
        $code = OrmGen::run($args, $stderr);
        $out = (string) ob_get_clean();
        rewind($stderr);
        return [$code, $out, (string) stream_get_contents($stderr)];
    }

    /** Runs $command in a new process from the repository root and returns its exit code, stdout and stderr. */
    private static function process(array $command): array
    {
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, dirname(__DIR__, 3));
        $out = (string) stream_get_contents($pipes[1]);
        $err = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        return [proc_close($process), $out, $err];
    }

    public function test_gen___check_compares_the_models_without_writing(): void
    {
        $work = self::$work;
        $dir = "$work/gen-check";
        @mkdir("$dir/model", 0o700, true);
        file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n\ntable tag {\n  seq i64\n  primary key (seq)\n}\n");
        $set = self::setFile($dir, ['example.dbs']);
        $args = ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--check'];
        [$code] = self::tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
        self::assertTrue($code === 0, 'gen');
        file_put_contents("$dir/model/Notes.php", "<?php\n");
        [$code, $out, $err] = self::tool($args);
        self::assertTrue($code === 0 && $out === '' && $err === '', "current: $code $out $err");
        file_put_contents("$dir/model/Item.php", "<?php\n");
        unlink("$dir/model/Tag.php");
        file_put_contents("$dir/model/Removed.php", "<?php\n" . \Polyspec\Orm\Generator::MARKER . "\n");
        $before = array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php"));
        [$code, $out] = self::tool($args);
        self::assertTrue($code === 1 && $out === "differs: $dir/model/Item.php\nextra: $dir/model/Removed.php\nmissing: $dir/model/Tag.php\n", "differences: $code $out");
        self::assertTrue(array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php")) === $before, 'gen --check wrote files');
    }

    // Requirements: DBS-4, DBS-27, DBS-155.
    public function test_gen_rejects_a_file_without_the_dbspec_signature(): void
    {
        $work = self::$work;
        // The byte check rejects the DbSchema project XML and the empty file before the parse, and every
        // file's diagnostic is printed.
        $set = self::setFile("$work/signature", ['dbschema.dbs', 'empty.dbs']);
        foreach (['dbschema.dbs', 'empty.dbs'] as $name) {
            copy(dirname(__DIR__, 3) . "/tests/dbspec/files/$name", "$work/signature/$name");
        }
        $dir = "$work/signature/model";
        [$code, $out, $err] = self::tool(['gen', '--set', $set, '--out', $dir, '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
        $want = "orm-gen: SCHEMA_INVALID: $work/signature/dbschema.dbs:1:1: signature: $work/signature/dbschema.dbs is not a dbspec document\n"
            . "$work/signature/empty.dbs:1:1: signature: $work/signature/empty.dbs is not a dbspec document\n";
        self::assertTrue($code === 1 && $out === '' && $err === $want, "$code $out $err");
        self::assertTrue(!file_exists($dir), "gen wrote $dir");
    }

    // Requirements: DBS-19, DBS-25, DBS-27, SCH-1.
    public function test_gen_prints_every_error_of_the_set_file_and_writes_nothing(): void
    {
        $work = self::$work;
        $dir = "$work/set-errors";
        $set = self::setFile($dir, ['gone.dbs', 'sub\\x.dbs']);
        [$code, $out, $err] = self::tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
        $want = "orm-gen: CONFIG: set.file: $dir/gone.dbs: gone.dbs is not a name that $dir/ lists\n"
            . "set.path: $set: the documents path \"sub\\\\x.dbs\" has no normal form\n";
        self::assertTrue($code === 1 && $out === '' && $err === $want, "$code $out $err");
        self::assertTrue(!file_exists("$dir/model"), 'gen wrote the models');
    }

    // Requirements: DBS-5, DBS-98, SCH-1.
    public function test_gen_takes_the_documents_only_from_the_set_file(): void
    {
        $work = self::$work;
        $dir = "$work/positional";
        $set = self::setFile($dir, ['example.dbs']);
        file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  primary key (seq)\n}\n");
        foreach ([['--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"], ['--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"], ['--set', $set, '--use', "$dir/example.dbs", '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']] as $args) {
            [$code, $out, $err] = self::tool(['gen', ...$args]);
            self::assertTrue($code === 2 && $out === '' && str_contains($err, 'usage: orm-gen gen --set '), json_encode($args) . ": $code $out $err");
        }
        self::assertTrue(!file_exists("$dir/model"), 'gen wrote the models');
    }

    public function test_gen_rejects_a_column_named_after_a_model_method(): void
    {
        // The test of DSL-127 (docs/spec).
        $work = self::$work;
        // restore() is a method of every model, so it overlaps with the condition method of a restore column.
        $dir = "$work/gen-reserved";
        @mkdir("$dir/model", 0o700, true);
        $set = self::setFile($dir, ['example.dbs']);
        foreach (['create', 'restore'] as $column) {
            file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  $column varchar(32)\n  primary key (seq)\n}\n");
            [$code, $out, $err] = self::tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
            self::assertTrue($code !== 0 && str_contains($out . $err, "column name is a reserved method name: $column"), "$column: $code $out $err");
        }
    }

    // Requirements: DBS-104, DBS-105, DBS-110.
    public function test_gen_generates_the_owned_and_the_used_external_tables_of_a_set(): void
    {
        $work = self::$work;
        // member.dbs uses ext_account and ext_audit of core.dbs, an external document of the set: each used external table
        // gets a read-only model (docs/spec/dbspec.md "External documents"), an unused one (ext_session) none, and the
        // bootstrap holds the text of the used external tables.
        $root = dirname(__DIR__, 3);
        $dir = "$work/gen-use";
        $set = self::setFile("$dir/set/app", ['member.dbs'], ['../core/core.dbs']);
        @mkdir("$dir/set/core", 0o700, true);
        copy("$root/contracts/fixtures/external/member.dbs", "$dir/set/app/member.dbs");
        copy("$root/contracts/fixtures/external/core.dbs", "$dir/set/core/core.dbs");
        [$code, $out, $err] = self::tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
        self::assertTrue($code === 0, "gen: $code $out $err");
        $files = array_map('basename', glob("$dir/model/*.php") ?: []);
        sort($files);
        self::assertTrue($files === ['ExtAccount.php', 'ExtAudit.php', 'ExtPost.php', 'ExtPostHistory.php', 'bootstrap.php'], 'generated files ' . json_encode($files));
        $bootstrap = (string) @file_get_contents("$dir/model/bootstrap.php");
        self::assertTrue(str_contains($bootstrap, 'const EXTERNAL_TEXT = ') && str_contains($bootstrap, 'table ext_account {') && !str_contains($bootstrap, 'table ext_session {'), 'bootstrap carries the used external tables');
        [$code, $out] = self::tool(['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--check']);
        self::assertTrue($code === 0 && $out === '', "gen --check with external documents: $code $out");
    }

    public function test_gen_writes_the_same_models_however_the_paths_are_written(): void
    {
        $work = self::$work;
        // The PHP generator scans no source, so only the set and output paths are written relative, absolute,
        // with `./` and with a trailing `/` (the output only: a set path ends in its file name).
        $dir = "$work/gen-path-spelling";
        self::setFile($dir, ['example.dbs']);
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
                [$code, , $err] = self::tool(['gen', '--set', $set, '--out', $out, '--namespace', 'Polyspec\\Orm\\Tests\\Example']);
                self::assertTrue($code === 0, "$name: $code $err");
                $files = [];
                foreach (glob("$dir/model/*.php") as $file) {
                    $files[basename($file)] = file_get_contents($file);
                }
                $first ??= $files;
                self::assertTrue($files !== [] && $files === $first, "the models of the $name paths differ from the relative paths");
            }
        } finally {
            chdir($previous);
        }
    }

    public function test_gen_is_the_only_command(): void
    {
        foreach (['build', 'ddl', 'diff', 'validate', 'migrate', 'import'] as $command) {
            [$code, $out, $err] = self::tool([$command]);
            self::assertTrue($code === 2 && $out === '' && str_starts_with($err, "usage: orm-gen gen ") && substr_count($err, "\n") === 1, "$command: $code $out $err");
        }
    }

    public function test_the_bin_Composer_installs_loads_the_autoloader(): void
    {
        [$code, $out, $err] = self::process([PHP_BINARY, 'vendor-php/bin/orm-gen']);
        self::assertTrue($code === 2 && $out === '' && str_starts_with($err, 'usage: orm-gen gen '), "vendor-php/bin/orm-gen: $code $out $err");
    }

    public function test_the_bin_outside_Composer_names_the_missing_autoloader(): void
    {
        // packages/php has its own vendor (its PHPUnit), so the bin runs from a copy of the package's bin folder
        // beside no vendor folder.
        $bin = self::$work . '/package/bin';
        @mkdir($bin, 0o700, true);
        // __DIR__ of the bin is the real path of its folder.
        $bin = realpath($bin);
        copy(dirname(__DIR__) . '/bin/orm-gen', "$bin/orm-gen");
        [$code, $out, $err] = self::process([PHP_BINARY, "$bin/orm-gen"]);
        $missing = "$bin/../vendor/autoload.php";
        self::assertTrue($code === 2 && $out === '' && $err === "orm-gen: no Composer autoloader at $missing; run the vendor/bin/orm-gen that Composer installs\n", "$bin/orm-gen: $code $out $err");
    }
}
