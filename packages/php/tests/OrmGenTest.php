<?php

// orm-gen command line test: gen writes and checks the models of a dbspec
// document set.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenTest.php
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

// Each case runs orm-gen in this process and writes and reads models in a temporary directory,
// except the bin cases, which run the bin in a new process.
#[Small]
final class OrmGenTest extends TestCase
{
    private static string $work;

    public static function setUpBeforeClass(): void
    {
        self::$work = OrmGenTestSupport::createWorkDirectory('orm-php-orm-gen-');
    }

    public static function tearDownAfterClass(): void
    {
        OrmGenTestSupport::removeWorkDirectory(self::$work);
    }

    private static function tool(array $args): array
    {
        return OrmGenTestSupport::run($args);
    }

    /** Runs $command in a new process from the repository root and returns its exit code, stdout and stderr. */
    private static function process(array $command): array
    {
        return OrmGenTestSupport::runProcess($command, dirname(__DIR__, 3))
            ?? throw new \RuntimeException('cannot start ' . implode(' ', $command));
    }

    // Requirements: DBS-104, DBS-112, DBS-114, INT-66.
    public function testGeneratedTypedGetterUsesPrivateModelStorageAndRejectsUnselectedRead(): void
    {
        $dir = self::$work . '/typed-getter';
        $namespace = 'Polyspec\\Orm\\Tests\\GeneratedTypedGetter';
        $set = OrmGenTestSupport::setFile($dir, ['typed.dbs']);
        file_put_contents(
            "$dir/typed.dbs",
            "dbspec 1 typed\n\ntable item {\n  price i32\n  primary key (price)\n}\n"
        );
        [$code, $out, $err] = self::tool([
            'gen', '--set', $set, '--out', "$dir/model", '--namespace', $namespace
        ]);
        self::assertSame(0, $code, "$out $err");
        $source = file_get_contents("$dir/model/Item.php");
        self::assertIsString($source);
        foreach (['@phpstan-ignore', 'phpcs:ignore'] as $suppression) {
            self::assertStringNotContainsString($suppression, $source, "generated PHP carries $suppression");
        }
        require_once "$dir/model/Item.php";

        $class = "$namespace\\Item";
        self::assertSame(
            'sha256:' . hash('sha256', file_get_contents("$dir/typed.dbs")),
            $class::meta()['manifest_hash']
        );
        $model = new $class();
        $getter = new \ReflectionMethod($class, 'getPrice');
        self::assertSame('int', $getter->getReturnType()->getName());
        self::assertFalse($getter->isInternal());
        self::assertSame([], (new \ReflectionClass($class))->getProperties());
        self::assertTrue((new \ReflectionProperty(\Polyspec\Orm\Model::class, 'values'))->isPrivate());

        OrmGenTestSupport::assertGeneratedTypedGetter(
            $this,
            $model,
            'getPrice',
            'setPrice',
            \Polyspec\Orm\Code::COLUMN_UNSELECTED
        );
    }

    // Requirements: DBS-175.
    public function testGenCheckComparesTheModelsWithoutWriting(): void
    {
        $work = self::$work;
        $dir = "$work/gen-check";
        is_dir("$dir/model") || mkdir("$dir/model", 0o700, true);
        file_put_contents(
            "$dir/example.dbs",
            "dbspec 1 example\n\ntable item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n\ntable tag "
            . "{\n  seq i64\n  primary key (seq)\n}\n"
        );
        $set = OrmGenTestSupport::setFile($dir, ['example.dbs']);
        $args = [
            'gen',
            '--set',
            $set,
            '--out',
            "$dir/model",
            '--namespace',
            'Polyspec\\Orm\\Tests\\Example',
            '--check'
        ];
        [$code] = self::tool(
            ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']
        );
        self::assertTrue($code === 0, 'gen');
        file_put_contents("$dir/model/Notes.php", "<?php\n");
        [$code, $out, $err] = self::tool($args);
        self::assertTrue($code === 0 && $out === '' && $err === '', "current: $code $out $err");
        file_put_contents("$dir/model/Item.php", "<?php\n");
        unlink("$dir/model/Tag.php");
        file_put_contents("$dir/model/Removed.php", "<?php\n" . \Polyspec\Orm\Generator::MARKER . "\n");
        $before = array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php"));
        [$code, $out] = self::tool($args);
        self::assertTrue(
            $code === 1
                && $out === "differs: $dir/model/Item.php\nextra: $dir/model/Removed.php\n"
                    . "missing: $dir/model/Tag.php\n",
            "differences: $code $out"
        );
        self::assertTrue(
            array_map(fn($f) => file_get_contents($f), glob("$dir/model/*.php")) === $before,
            'gen --check wrote files'
        );
    }

    // Requirements: DBS-4, DBS-27, DBS-155.
    public function testGenRejectsAFileWithoutTheDbspecSignature(): void
    {
        $work = self::$work;
        // The byte check rejects the DbSchema project XML and the empty file before the parse, and every
        // file's diagnostic is printed.
        $set = OrmGenTestSupport::setFile("$work/signature", ['dbschema.dbs', 'empty.dbs']);
        foreach (['dbschema.dbs', 'empty.dbs'] as $name) {
            copy(dirname(__DIR__, 3) . "/tests/dbspec/files/$name", "$work/signature/$name");
        }
        $dir = "$work/signature/model";
        [$code, $out, $err] = self::tool(
            ['gen', '--set', $set, '--out', $dir, '--namespace', 'Polyspec\\Orm\\Tests\\Example']
        );
        $want = "orm-gen: SCHEMA_INVALID: $work/signature/dbschema.dbs:1:1: "
            . "signature: $work/signature/dbschema.dbs is not a dbspec document\n"
            . "$work/signature/empty.dbs:1:1: signature: $work/signature/empty.dbs is not a dbspec document\n";
        self::assertTrue($code === 1 && $out === '' && $err === $want, "$code $out $err");
        self::assertTrue(!file_exists($dir), "gen wrote $dir");
    }

    // Requirements: DBS-19, DBS-25, DBS-27, SCH-1, ORES-36.
    public function testGenPrintsEveryErrorOfTheSetFileAndWritesNothing(): void
    {
        $work = self::$work;
        $dir = "$work/set-errors";
        $set = OrmGenTestSupport::setFile($dir, ['gone.dbs', 'sub\\x.dbs']);
        [$code, $out, $err] = self::tool(
            ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']
        );
        $want = "orm-gen: CONFIG: set.file: $dir/gone.dbs: gone.dbs is not a name that $dir/ lists\n"
            . "set.path: $set: the documents path \"sub\\\\x.dbs\" has no normal form\n";
        self::assertTrue($code === 1 && $out === '' && $err === $want, "$code $out $err");
        self::assertTrue(!file_exists("$dir/model"), 'gen wrote the models');
    }

    // Requirements: DBS-5, DBS-98, SCH-1, ORES-21.
    public function testGenTakesTheDocumentsOnlyFromTheSetFile(): void
    {
        $work = self::$work;
        $dir = "$work/positional";
        $set = OrmGenTestSupport::setFile($dir, ['example.dbs']);
        file_put_contents("$dir/example.dbs", "dbspec 1 example\n\ntable item {\n  seq i64\n  primary key (seq)\n}\n");
        foreach (
            [
            ['--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"],
            ['--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', "$dir/example.dbs"],
            [
                '--set',
                $set,
                '--use',
                "$dir/example.dbs",
                '--out',
                "$dir/model",
                '--namespace',
                'Polyspec\\Orm\\Tests\\Example'
            ]
            ] as $args
        ) {
            [$code, $out, $err] = self::tool(['gen', ...$args]);
            self::assertTrue(
                $code === 2 && $out === '' && str_contains($err, 'usage: orm-gen gen --set '),
                json_encode($args) . ": $code $out $err"
            );
        }
        self::assertTrue(!file_exists("$dir/model"), 'gen wrote the models');
    }

    // Requirements: DSL-130.
    public function testGenRejectsAColumnNameWithAnOperatorOrConnectorSegment(): void
    {
        $dir = self::$work . '/gen-segment';
        is_dir("$dir/model") || mkdir("$dir/model", 0o700, true);
        $set = OrmGenTestSupport::setFile($dir, ['example.dbs']);
        foreach (['price_gt_limit' => 'gt', 'with_tax' => 'with', 'min_price' => null] as $column => $segment) {
            file_put_contents(
                "$dir/example.dbs",
                "dbspec 1 example\n\ntable item {\n  seq i64\n  $column i32\n  primary key (seq)\n}\n"
            );
            [$code, $out, $err] = self::tool(
                ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']
            );
            if ($segment === null) {
                self::assertSame(0, $code, "$column: $out $err");
                continue;
            }
            self::assertTrue(
                $code !== 0 && str_contains($out . $err, "column name may not contain the segment \"$segment\": $column"),
                "$column: $code $out $err"
            );
        }
    }

    // Requirements: DSL-127, PLN-22.
    public function testGenRejectsAColumnNamedAfterAModelMethod(): void
    {
        // The test of DSL-127 (docs/spec).
        $work = self::$work;
        // restore() is a method of every model, so it overlaps with the condition method of a restore column.
        $dir = "$work/gen-reserved";
        is_dir("$dir/model") || mkdir("$dir/model", 0o700, true);
        $set = OrmGenTestSupport::setFile($dir, ['example.dbs']);
        foreach (['create', 'restore'] as $column) {
            file_put_contents(
                "$dir/example.dbs",
                "dbspec 1 example\n\ntable item {\n  seq i64\n  $column varchar(32)\n  primary key (seq)\n}\n"
            );
            [$code, $out, $err] = self::tool(
                ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']
            );
            self::assertTrue(
                $code !== 0 && str_contains($out . $err, "column name is a reserved method name: $column"),
                "$column: $code $out $err"
            );
        }
    }

    // Requirements: DBS-104, DBS-105, DBS-110.
    public function testGenGeneratesTheOwnedAndTheUsedExternalTablesOfASet(): void
    {
        $work = self::$work;
        // member.dbs uses ext_account and ext_audit of core.dbs, an external document of the set: each used external
        // table gets a read-only model (docs/spec/dbspec.md "External documents"), an unused one (ext_session) none,
        // and the bootstrap holds the text of the used external tables.
        $root = dirname(__DIR__, 3);
        $dir = "$work/gen-use";
        $set = OrmGenTestSupport::setFile("$dir/set/app", ['member.dbs'], ['../core/core.dbs']);
        is_dir("$dir/set/core") || mkdir("$dir/set/core", 0o700, true);
        copy("$root/contracts/fixtures/external/member.dbs", "$dir/set/app/member.dbs");
        copy("$root/contracts/fixtures/external/core.dbs", "$dir/set/core/core.dbs");
        [$code, $out, $err] = self::tool(
            ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example']
        );
        self::assertTrue($code === 0, "gen: $code $out $err");
        $files = array_map('basename', glob("$dir/model/*.php") ?: []);
        sort($files);
        self::assertTrue(
            $files === [
                'ExtAccount.php',
                'ExtAudit.php',
                'ExtPost.php',
                'ExtPostHistory.php',
                'bootstrap.php',
                'schema_declarations.php'
            ],
            'generated files ' . json_encode($files)
        );
        // The text is written in pieces joined by the concatenation operator (Generator::text), so the pieces are
        // joined back first.
        $path = "$dir/model/schema_declarations.php";
        self::assertFileExists($path, 'the generation writes schema_declarations.php');
        $declarations = (string) file_get_contents($path);
        $text = str_replace("'\n    . '", '', $declarations);
        self::assertTrue(
            str_contains(
                $declarations,
                'const EXTERNAL_TEXT = '
            ) && str_contains($text, 'table ext_account {') && !str_contains($text, 'table ext_session {'),
            'the declarations carry the used external tables'
        );
        [$code, $out] = self::tool(
            ['gen', '--set', $set, '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Example', '--check']
        );
        self::assertTrue($code === 0 && $out === '', "gen --check with external documents: $code $out");
    }

    // Requirements: DSL-42.
    public function testGenWritesTheSameModelsHoweverThePathsAreWritten(): void
    {
        $work = self::$work;
        // The PHP generator scans no source, so only the set and output paths are written relative, absolute,
        // with `./` and with a trailing `/` (the output only: a set path ends in its file name).
        $dir = "$work/gen-path-spelling";
        OrmGenTestSupport::setFile($dir, ['example.dbs']);
        file_put_contents(
            "$dir/example.dbs",
            "dbspec 1 example\n\ntable item {\n  seq i64\n  name varchar(32)\n  primary key (seq)\n}\n"
        );
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
                [$code, , $err] = self::tool(
                    ['gen', '--set', $set, '--out', $out, '--namespace', 'Polyspec\\Orm\\Tests\\Example']
                );
                self::assertTrue($code === 0, "$name: $code $err");
                $files = [];
                foreach (glob("$dir/model/*.php") as $file) {
                    $files[basename($file)] = file_get_contents($file);
                }
                $first ??= $files;
                self::assertTrue(
                    $files !== [] && $files === $first,
                    "the models of the $name paths differ from the relative paths"
                );
            }
        } finally {
            chdir($previous);
        }
    }

    // Requirements: DSL-42.
    public function testGenIsTheOnlyCommand(): void
    {
        foreach (['build', 'ddl', 'diff', 'validate', 'migrate', 'import'] as $command) {
            [$code, $out, $err] = self::tool([$command]);
            self::assertTrue(
                $code === 2 && $out === '' && str_starts_with(
                    $err,
                    "usage: orm-gen gen "
                ) && substr_count($err, "\n") === 1,
                "$command: $code $out $err"
            );
        }
    }

    // Requirements: DSL-42.
    public function testTheBinComposerInstallsLoadsTheAutoloader(): void
    {
        [$code, $out, $err] = self::process([PHP_BINARY, 'vendor-php/bin/orm-gen']);
        self::assertTrue(
            $code === 2 && $out === '' && str_starts_with($err, 'usage: orm-gen gen '),
            "vendor-php/bin/orm-gen: $code $out $err"
        );
    }

    // Requirements: DSL-42.
    public function testTheBinOutsideComposerNamesTheMissingAutoloader(): void
    {
        // packages/php has its own vendor (its PHPUnit), so the bin runs from a copy of the package's bin folder
        // beside no vendor folder.
        $bin = self::$work . '/package/bin';
        is_dir($bin) || mkdir($bin, 0o700, true);
        // __DIR__ of the bin is the real path of its folder.
        $bin = realpath($bin);
        copy(dirname(__DIR__) . '/bin/orm-gen', "$bin/orm-gen");
        [$code, $out, $err] = self::process([PHP_BINARY, "$bin/orm-gen"]);
        $missing = "$bin/../vendor/autoload.php";
        self::assertTrue(
            $code === 2
                && $out === ''
                && $err === "orm-gen: no Composer autoloader "
                    . "at $missing; run the vendor/bin/orm-gen that Composer installs\n",
            "$bin/orm-gen: $code $out $err"
        );
    }
}
