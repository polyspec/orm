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
        $prefix = $root . '/php-prefix';
        mkdir($package . '/scripts', 0777, true);
        mkdir($package . '/src', 0777, true);
        mkdir($bin, 0777, true);
        mkdir($arginfo, 0777, true);
        mkdir($phpConfigBin, 0777, true);
        mkdir($prefix . '/lib/php/build', 0777, true);
        $marker = $root . '/invoked';

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
