<?php

declare(strict_types=1);

namespace Polyspec\Orm\Extension\Tests;

use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

#[Large]
final class ArginfoBuildTest extends TestCase
{
    public function testBuildRequiresTheInstalledGeneratorBeforeItCanRunToolsOrDownloadAnything(): void
    {
        $root = dirname(__DIR__, 4) . '/orm-arginfo-' . bin2hex(random_bytes(8));
        $testRoot = getenv('KIT_TEST_ROOT');
        if (!is_string($testRoot) || $testRoot === '') {
            throw new \RuntimeException('KIT_TEST_ROOT is required to find the pinned Node runtime');
        }
        $package = $root . '/packages/php-ext';
        $bin = $root . '/bin';
        $arginfo = $root . '/var/tools/php-arginfo';
        $phpConfigBin = $root . '/var/tools/bin';
        $kit = $root . '/node_modules/@polyspec/kit';
        $prefix = $root . '/php-prefix';
        mkdir($package . '/scripts', 0777, true);
        mkdir($package . '/src', 0777, true);
        mkdir($bin, 0777, true);
        mkdir($arginfo, 0777, true);
        mkdir($phpConfigBin, 0777, true);
        mkdir($kit . '/scripts', 0777, true);
        mkdir($prefix . '/lib/php/build', 0777, true);
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
            copy(__DIR__ . '/../composer.json', $package . '/composer.json');
            copy(__DIR__ . '/../src/polyspec_orm.stub.php', $package . '/src/polyspec_orm.stub.php');
            copy(__DIR__ . '/../src/config.m4', $package . '/src/config.m4');
            file_put_contents($kit . '/package.json', json_encode([
                'name' => '@polyspec/kit',
                'type' => 'module',
                'exports' => ['./php-extension' => './scripts/php-extension.mjs'],
            ], JSON_THROW_ON_ERROR));
            file_put_contents($kit . '/scripts/php-extension.mjs', <<<JS
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.KIT_CLI_PROOF, JSON.stringify({ file: import.meta.filename, args: process.argv.slice(2) }));
console.error('var/tools/php-arginfo/PHP-Parser-5.0.0/lib/PhpParser is missing; run make install-tools');
process.exit(1);
JS);
            $generator = "<?php\n\$version = \"5.0.0\";\n";
            file_put_contents($arginfo . '/gen_stub.php', $generator);
            file_put_contents($prefix . '/lib/php/build/gen_stub.php', $generator);
            $phpConfig = $phpConfigBin . '/php-config';
            file_put_contents($phpConfig, "#!/bin/sh\nprintf '%s\\n' " . escapeshellarg($prefix) . "\n");
            chmod($phpConfig, 0755);
            foreach (['phpize', 'php', 'curl', 'wget'] as $tool) {
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
                ['/bin/sh', $package . '/scripts/build.sh', $root . '/polyspec_orm.so'],
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

            self::assertSame(1, $exit, $output);
            self::assertStringContainsString('PHP-Parser-5.0.0/lib/PhpParser is missing', $output);
            self::assertStringContainsString('run make install-tools', $output);
            $proof = json_decode(file_get_contents($kitProof), true, flags: JSON_THROW_ON_ERROR);
            self::assertSame(realpath($kit . '/scripts/php-extension.mjs'), $proof['file']);
            self::assertSame(['build', '--output', $root . '/polyspec_orm.so', '--configure-arg', '--disable-polyspec-orm-native-test'], $proof['args']);
            self::assertFileDoesNotExist(
                $marker,
                'The build invoked phpize, PHP, or a downloader before reporting the missing generator.',
            );
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
