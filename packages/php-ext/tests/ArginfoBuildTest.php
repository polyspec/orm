<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

// build.sh delegates the build to the kit builder of the installed package. Arginfo comes from PHP's gen_stub.php,
// which the kit builder runs (K930), so build.sh runs no phpize, PHP or downloader of its own.
#[Large]
final class ArginfoBuildTest extends TestCase
{
    /** @return array<string, array{string, list<string>}> */
    public static function modes(): array
    {
        $cancel = ['--source-copy', 'packages/php/src/native/sqlite_cancel.c', 'src/native/sqlite_cancel.c'];
        return [
            'release' => ['release', [...$cancel, '--configure-arg', '--disable-polyspec-orm-native-test']],
            'native-test' => ['native-test', [
                ...$cancel,
                '--configure-arg',
                '--enable-polyspec-orm-native-test',
                '--source-copy',
                'packages/php-ext/testing/native/module.c',
                'src/native_test.c',
            ]],
        ];
    }

    /** @param list<string> $modeArgs */
    #[DataProvider('modes')]
    public function testBuildDelegatesEachModeToTheKitBuilderWithoutRunningATool(string $mode, array $modeArgs): void
    {
        $root = dirname(__DIR__, 4) . '/orm-arginfo-' . bin2hex(random_bytes(8));
        $testRoot = getenv('KIT_TEST_ROOT');
        if (!is_string($testRoot) || $testRoot === '') {
            throw new \RuntimeException('KIT_TEST_ROOT is required to find the pinned Node runtime');
        }
        $package = $root . '/packages/php-ext';
        $bin = $root . '/bin';
        $kit = $root . '/node_modules/@polyspec/kit';
        mkdir($package . '/scripts', 0777, true);
        mkdir($bin, 0777, true);
        mkdir($kit . '/scripts', 0777, true);
        $marker = $root . '/invoked';
        $kitProof = $root . '/kit-cli.json';

        try {
            $git = proc_open(
                ['git', 'init', '--quiet', $root],
                [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $gitPipes
            );
            self::assertIsResource($git);
            stream_get_contents($gitPipes[1]);
            $gitError = stream_get_contents($gitPipes[2]);
            fclose($gitPipes[1]);
            fclose($gitPipes[2]);
            self::assertSame(0, proc_close($git), $gitError);

            copy(__DIR__ . '/../scripts/build.sh', $package . '/scripts/build.sh');
            file_put_contents($kit . '/package.json', json_encode([
                'name' => '@polyspec/kit',
                'type' => 'module',
                'exports' => ['./php-extension' => './scripts/php-extension.mjs'],
            ], JSON_THROW_ON_ERROR));
            // The fake builder records how it was called and fails with a status and a message of its own, which
            // build.sh must return unchanged.
            file_put_contents($kit . '/scripts/php-extension.mjs', <<<JS
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.KIT_CLI_PROOF, JSON.stringify({ file: import.meta.filename, args: process.argv.slice(2) }));
console.error('the fake kit builder stopped');
process.exit(7);
JS);
            foreach (['phpize', 'php', 'php-config', 'curl', 'wget'] as $tool) {
                $file = $bin . '/' . $tool;
                file_put_contents(
                    $file,
                    "#!/bin/sh\nprintf '%s\\n' " . escapeshellarg($tool)
                        . " >> " . escapeshellarg($marker) . "\nexit 0\n",
                );
                chmod($file, 0755);
            }

            $pipes = [];
            $process = proc_open(
                ['/bin/sh', $package . '/scripts/build.sh', $root . '/polyspec_orm.so', $mode],
                [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
                $root,
                [
                    'PATH' => $bin . ':' . $testRoot . '/var/tools/bin:/usr/bin:/bin',
                    'HOME' => $root,
                    'TMPDIR' => $root,
                    'KIT_CLI_PROOF' => $kitProof,
                ]
            );
            self::assertIsResource($process);
            $stdout = stream_get_contents($pipes[1]);
            $stderr = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $exit = proc_close($process);
            $output = $stdout . $stderr;

            self::assertSame(7, $exit, $output);
            self::assertStringContainsString('the fake kit builder stopped', $output);
            $proof = json_decode(file_get_contents($kitProof), true, flags: JSON_THROW_ON_ERROR);
            self::assertSame(realpath($kit . '/scripts/php-extension.mjs'), $proof['file']);
            self::assertSame(['build', '--output', $root . '/polyspec_orm.so', ...$modeArgs], $proof['args']);
            self::assertFileDoesNotExist($marker, 'build.sh invoked phpize, PHP, or a downloader itself.');
        } finally {
            $this->removeTree($root);
        }
    }

    private function removeTree(string $directory): void
    {
        foreach (new \FilesystemIterator($directory) as $entry) {
            if ($entry->isDir() && !$entry->isLink()) {
                $this->removeTree($entry->getPathname());
            } else {
                unlink($entry->getPathname());
            }
        }
        rmdir($directory);
    }
}
