<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// model_generation feature coverage: with the same arguments as the committed generation command,
// running the orm-gen check mode reports that packages/php/gen is the same as the generator output,
// and reports that a copy with one byte changed is different.


use RuntimeException;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Large;
use PHPUnit\Framework\TestCase;

/** @return array{int, string} exit code and output of orm-gen check, run at the repository root */
function generationCheck(string $root, string $out): array
{
    [$status, $stdout, $stderr] = coverageProcess(
        [
            PHP_BINARY,
            'vendor-php/bin/orm-gen',
            'gen',
            '--set',
            'contracts/fixtures/bench/dbspec-set.json',
            '--out',
            $out,
            '--namespace',
            'Polyspec\\Orm\\Tests\\Model',
            '--check'
        ],
        $root,
    );
    return [$status, $stdout . $stderr];
}

#[Large]
final class CoverageModelGenerationTest extends TestCase
{
    public function testModelGenerationCheck(): void
    {
        $root = dirname(__DIR__, 3);
        [$status, $output] = generationCheck($root, 'packages/php/gen');
        Assert::assertTrue($status === 0 && $output === '', "check of the committed models exited $status: $output");
        $copy = sys_get_temp_dir() . '/orm-php-coverage-generation-' . getmypid();
        if (!mkdir($copy, 0o700, true)) {
            throw new RuntimeException("cannot create $copy");
        }
        try {
            foreach (glob("$root/packages/php/gen/*.php") ?: [] as $file) {
                if (!copy($file, "$copy/" . basename($file))) {
                    throw new RuntimeException("cannot copy $file");
                }
            }
            [$status, $output] = generationCheck($root, $copy);
            Assert::assertTrue($status === 0 && $output === '', "check of the unchanged copy exited $status: $output");
            // Changes one byte of the generated PHP body: the `B` of `final class Author` to `C`.
            $changed = "$copy/Author.php";
            $text = file_get_contents($changed);
            $at = $text === false ? false : strpos($text, 'final class Author');
            if ($at === false) {
                throw new RuntimeException("cannot read the class line of $changed");
            }
            $text[$at + strlen('final class ')] = 'C';
            if (file_put_contents($changed, $text) !== strlen($text)) {
                throw new RuntimeException("cannot write $changed");
            }
            [$status, $output] = generationCheck($root, $copy);
            Assert::assertTrue(
                $status === 1 && $output === "differs: $changed\n",
                "check of the changed copy exited $status: $output"
            );
        } finally {
            exec('rm -rf ' . escapeshellarg($copy), $removed, $code);
            if ($code !== 0) {
                throw new RuntimeException("cannot remove $copy");
            }
        }
    }
}
