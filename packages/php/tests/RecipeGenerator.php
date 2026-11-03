<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;

/**
 * The generator.generate op of the recipe helper (docs/spec/feature-coverage.md FCV-4): it writes the scanned PHP
 * sources of a step under a temporary root and runs orm-gen with that root as the scan input.
 */
final class RecipeGenerator
{
    /**
     * Runs one generator.check step (FCV-4, DBS-175) through orm-gen gen --check of this client.
     *
     * @param array<string, mixed> $step
     */
    public static function checkFiles(array $step, string $dir): void
    {
        $root = dirname(__DIR__, 3);
        $work = sys_get_temp_dir() . '/orm-recipe-generator-check-' . bin2hex(random_bytes(8));
        mkdir($work, 0o700, true);
        $out = "$work/model";
        $gen = static function (string ...$extra) use ($root, $dir, $step, $out): array {
            [$status, $stdout, $stderr] = coverageProcess(
                [PHP_BINARY, 'vendor-php/bin/orm-gen', 'gen', '--set', "$dir/{$step['document_set']}", '--out', $out,
                    '--namespace', 'Polyspec\\Orm\\Tests\\RecipeCheck', ...$extra],
                $root,
            );
            return [$status, $stdout . $stderr];
        };
        $expect = static function (array $lines, string $file) use ($gen): void {
            $want = implode('', array_map(static fn (string $line): string => str_replace('<file>', $file, $line) . "\n", $lines));
            Assert::assertSame([$lines === [] ? 0 : 1, $want], $gen('--check'));
        };
        try {
            [$status, $output] = $gen();
            Assert::assertSame(0, $status, $output);
            $files = glob("$out/*") ?: [];
            sort($files);
            $file = null;
            foreach ($files as $candidate) {
                if (is_file($candidate) && filesize($candidate) > 0) {
                    $file = $candidate;
                    break;
                }
            }
            Assert::assertNotNull($file, "$out holds no generated file");
            // A file that the generation does not write and that does not carry the marker is not compared.
            file_put_contents("$out/ZzNotes.php", "<?php\n");
            $expect($step['unchanged'], '');
            $text = (string) file_get_contents($file);
            $text[0] = chr(ord($text[0]) ^ 1);
            file_put_contents($file, $text);
            $expect($step['changed'], $file);
            Assert::assertSame($text, file_get_contents($file), 'the check wrote the file');
            unlink($file);
            $expect($step['removed'], $file);
            Assert::assertFileDoesNotExist($file, 'the check wrote the file');
        } finally {
            foreach (glob("$out/*") ?: [] as $file) {
                unlink($file);
            }
            if (is_dir($out)) {
                rmdir($out);
            }
            rmdir($work);
        }
    }

    /**
     * Runs one generator.refused step (FCV-4, DBS-27) through orm-gen gen of this client.
     *
     * @param array<string, mixed> $step
     */
    public static function checkRefused(array $step, string $dir): void
    {
        $work = sys_get_temp_dir() . '/orm-recipe-generator-refused-' . bin2hex(random_bytes(8));
        mkdir($work, 0o700, true);
        $out = "$work/model";
        try {
            foreach ($step['files'] as $name => $entry) {
                $text = is_string($entry) ? $entry : file_get_contents("$dir/{$entry['path']}");
                file_put_contents("$work/$name", $text);
            }
            [$status, $stdout, $stderr] = coverageProcess(
                [PHP_BINARY, 'vendor-php/bin/orm-gen', 'gen', '--set', "$work/dbspec-set.json", '--out', $out,
                    '--namespace', 'Polyspec\\Orm\\Tests\\RecipeRefused',
                    ...(($step['check'] ?? false) ? ['--check'] : [])],
                dirname(__DIR__, 3),
            );
            Assert::assertSame([1, ''], [$status, $stdout], $stderr);
            $from = 0;
            foreach ($step['parts'] as $part) {
                $at = strpos($stderr, $part, $from);
                Assert::assertNotFalse($at, "the output lacks $part in order: $stderr");
                $from = $at + strlen($part);
            }
            Assert::assertFileDoesNotExist($out, 'the generation wrote the output');
        } finally {
            array_map('unlink', glob("$work/*") ?: []);
            rmdir($work);
        }
    }

    /** Runs one generator.generate step and checks it against the expect of $database. */
    public static function check(array $step, string $dir, string $database): void
    {
        $want = $step['expect'][$database] ?? Assert::fail("generator.generate has no expect for $database");
        $root = sys_get_temp_dir() . '/orm-recipe-generator-' . bin2hex(random_bytes(8));
        mkdir($root, 0o700, true);
        try {
            [$code, $error] = self::generate($step, $dir, $root);
            if (isset($want['error'])) {
                Assert::assertNotSame(0, $code, "generation succeeded, want error {$want['error']}");
                Assert::assertStringContainsString("orm-gen: {$want['error']}: ", $error);
                Assert::assertDirectoryDoesNotExist("$root/model", 'a refused generation writes nothing');
                if (isset($want['message'])) {
                    Assert::assertStringContainsString($want['message'], $error);
                }
                if (isset($want['position'])) {
                    Assert::assertStringContainsString(".php:{$want['position']['line']}:", $error);
                }
                return;
            }
            Assert::assertSame(0, $code, $error);
            $names = self::generatedMethods("$root/model");
            foreach ($want['value']['includes'] as $name) {
                Assert::assertContains($name, $names, "generated code lacks $name");
            }
            foreach ($want['value']['excludes'] as $name) {
                Assert::assertNotContains($name, $names, "generated code declares $name");
            }
            $text = implode('', array_map(file_get_contents(...), glob("$root/model/*") ?: []));
            foreach ($want['value']['text']['includes'] ?? [] as $part) {
                Assert::assertStringContainsString($part, $text, "generated text lacks $part");
            }
            foreach ($want['value']['text']['excludes'] ?? [] as $part) {
                Assert::assertStringNotContainsString($part, $text, "generated text holds $part");
            }
        } finally {
            self::remove($root);
        }
    }

    /** @return array{int, string} the exit status and the error output of the generation of the set of the step */
    private static function generate(array $step, string $dir, string $root): array
    {
        $options = $step['options'] ?? [];
        foreach ($options['sources']['php'] ?? [] as $path => $text) {
            is_dir(dirname("$root/$path")) || mkdir(dirname("$root/$path"), 0o700, true);
            file_put_contents("$root/$path", $text);
        }
        $before = $options['before'] ?? null;
        if ($before !== null) {
            $set = self::setFile("$root/.set-before", $dir, [$before['schema']], []);
            $output = $before['output'];
            [$code, $error] = self::run($set, "$root/$output", $output, "$root/{$before['scan']}");
            if ($code !== 0) {
                return [$code, $error];
            }
        }
        $set = self::setFile("$root/.set", $dir, [$step['schema']], $options['used'] ?? []);
        if (isset($options['schema_replace'])) {
            $document = dirname($set) . '/' . basename($step['schema']);
            $text = (string) file_get_contents($document);
            $replace = $options['schema_replace'];
            file_put_contents($document, str_replace($replace['from'], $replace['to'], $text));
        }
        return self::run($set, "$root/model", 'model', $root);
    }

    /** @return array{int, string} */
    private static function run(string $set, string $out, string $directory, string $scan): array
    {
        $namespace = 'Example\\' . ucfirst($directory);
        [$code, , $error] = OrmGenTestSupport::run(
            ['gen', '--set', $set, '--out', $out, '--namespace', $namespace, '--scan', $scan]
        );
        return [$code, $error];
    }

    /**
     * Writes a set file in $at/set over copies of the documents of the recipe directory $dir.
     *
     * @param list<string> $documents
     * @param list<string> $external
     */
    private static function setFile(string $at, string $dir, array $documents, array $external): string
    {
        foreach (['set' => $documents, 'external' => $external] as $group => $names) {
            is_dir("$at/$group") || mkdir("$at/$group", 0o700, true);
            foreach ($names as $name) {
                copy("$dir/$name", "$at/$group/" . basename($name));
            }
        }
        $external = array_map(static fn(string $name): string => '../external/' . basename($name), $external);
        return OrmGenTestSupport::setFile("$at/set", array_map(basename(...), $documents), $external);
    }

    /** @return list<string> the methods of each generated model as table.name, without the language prefix (FCV-4) */
    private static function generatedMethods(string $out): array
    {
        $names = [];
        foreach (glob("$out/*.php") ?: [] as $file) {
            $table = self::snake(basename($file, '.php'));
            $names[] = $table;
            preg_match_all('/^    public function (\w+)\(/m', (string) file_get_contents($file), $members);
            foreach ([...OrmGenTestSupport::phpMethodNames($file), ...$members[1]] as $method) {
                $names[] = "$table." . self::snake((string) preg_replace('/^(?:get|new|alias)(?=[A-Z])/', '', $method));
            }
        }
        return $names;
    }

    private static function snake(string $name): string
    {
        return strtolower((string) preg_replace('/(?<!^)[A-Z]/', '_$0', $name));
    }

    private static function remove(string $path): void
    {
        if (is_dir($path)) {
            foreach (array_diff(scandir($path) ?: [], ['.', '..']) as $entry) {
                self::remove("$path/$entry");
            }
            rmdir($path);
            return;
        }
        unlink($path);
    }
}
