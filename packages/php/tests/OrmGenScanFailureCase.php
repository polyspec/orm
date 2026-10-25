<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

trait OrmGenScanFailureCase
{
    // Requirements: DSL-152.
    public function testAFileThatDoesNotParseStopsTheGenerationAndNamesItsPosition(): void
    {
        $root = getcwd();
        $class = preg_replace('/[^A-Za-z0-9]/', '-', static::class);
        $work = OrmGenTestSupport::createWorkDirectory("orm-php-orm-gen-dsl152-$class-");
        $dir = "$work/unparsable";
        try {
            if (!mkdir("$dir/src", 0o700, true)) {
                throw new \RuntimeException("cannot create $dir/src");
            }
            file_put_contents("$dir/src/usage.php", "<?php\n\$x = 1;\n");
            file_put_contents("$dir/src/broken.php", "<?php\n\$a = new (;\n");

            $this->exerciseGeneratedModelRuntime($root, $work);

            // The PHP extension uses the same PHP OrmGen entry point; it does not implement a second generator.
            [$code, $stdout, $stderr] = OrmGenTestSupport::run([
                'gen',
                '--set',
                "$root/contracts/fixtures/bench/dbspec-set.json",
                '--out',
                "$dir/model",
                '--namespace',
                'Polyspec\\Orm\\Tests\\Scanned',
                '--scan',
                "$dir/src",
            ]);
            self::assertSame(1, $code, $stdout . $stderr);
            self::assertMatchesRegularExpression('~broken\\.php:2:\\d+: does not parse: ~', $stderr);
            self::assertDirectoryDoesNotExist("$dir/model");
        } finally {
            OrmGenTestSupport::removeWorkDirectory($work);
        }
    }

    protected function exerciseGeneratedModelRuntime(string $root, string $work): void
    {
    }
}
