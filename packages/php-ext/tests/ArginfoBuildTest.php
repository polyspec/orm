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
        $root = sys_get_temp_dir() . '/orm-arginfo-' . bin2hex(random_bytes(8));
        $package = $root . '/packages/php-ext';
        $bin = $root . '/bin';
        $arginfo = $root . '/php-arginfo';
        mkdir($package . '/scripts', 0777, true);
        mkdir($package . '/src', 0777, true);
        mkdir($bin, 0777, true);
        mkdir($arginfo, 0777, true);
        $marker = $root . '/invoked';

        try {
            copy(__DIR__ . '/../scripts/build.sh', $package . '/scripts/build.sh');
            file_put_contents($arginfo . '/gen_stub.php', "<?php\n\$version = \"5.0.0\";\n");
            foreach (['phpize', 'php-config', 'php', 'curl', 'wget'] as $tool) {
                $file = $bin . '/' . $tool;
                file_put_contents($file, "#!/bin/sh\nprintf '%s\\n' " . escapeshellarg($tool) . " >> " . escapeshellarg($marker) . "\nexit 0\n");
                chmod($file, 0755);
            }

            $pipes = [];
            $process = proc_open(
                ['/bin/sh', $package . '/scripts/build.sh', $root . '/polyspec_orm.so'],
                [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                $pipes,
                $root,
                ['PATH' => $bin . ':/usr/bin:/bin', 'HOME' => $root, 'TMPDIR' => $root]
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
            self::assertFileDoesNotExist($marker, 'The build invoked PHP tools or attempted a downloader before reporting the missing generator.');
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
