<?php

// Parity of the PHP and the node orm-gen scan: for each case of tests/generator/php-scan-vectors.json the two generators
// declare the same chain methods on the model and reject the same names. The node generator is the built packages/ts
// (npm run typescript:build); it does not check argument counts, so the cases marked parity false are left out.
// Usage: vendor-php/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanParityTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmGen;

#[Small]
final class OrmGenScanParityTest extends TestCase
{
    private static string $work;

    public static function setUpBeforeClass(): void
    {
        self::$work = sys_get_temp_dir() . '/orm-php-scan-parity-' . getmypid();
        @mkdir(self::$work, 0o700, true);
    }

    public static function tearDownAfterClass(): void
    {
        exec('rm -rf ' . escapeshellarg(self::$work));
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function vectors(): array
    {
        $file = dirname(__DIR__, 3) . '/tests/generator/php-scan-vectors.json';
        $out = [];
        foreach (json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR)['cases'] as $case) {
            if (($case['parity'] ?? true) === true) {
                $out[$case['id']] = [$case];
            }
        }
        return $out;
    }

    /** The names the node orm-gen declares on the model for these calls; null when it fails. */
    private static function node(array $case, string $dir): ?array
    {
        $root = dirname(__DIR__, 3);
        $bin = "$root/packages/ts/dist/bin/orm-gen.js";
        self::assertFileExists($bin, 'run npm run typescript:build first');
        // A case with a receiver is (new C), the one form besides a variable that the node scan resolves; the invoke cases are parity false.
        $receiver = isset($case['receiver']) ? "(new {$case['model']}())" : 'm';
        $steps = array_map(static fn(array $c): string => "{$c['name']}(" . implode(', ', array_fill(0, $c['args'], '1')) . ')', $case['calls']);
        $calls = ($case['chain'] ?? false) ? "$receiver." . implode('.', $steps) . ";\n"
            : implode('', array_map(static fn(string $step): string => "$receiver.$step;\n", $steps));
        file_put_contents("$dir/usage.ts", "import { {$case['model']} } from './models/models.js';\nconst m = new {$case['model']}();\n$calls");
        $process = proc_open(
            ['node', $bin, 'gen', '--set', "$root/contracts/fixtures/bench/dbspec-set.json", '--out', "$dir/models", '--scan', "$dir/usage.ts"],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            $root
        );
        stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        $code = proc_close($process);
        if ($code !== 0) {
            return null;
        }
        $text = (string) file_get_contents("$dir/models/models.ts");
        preg_match("/export class {$case['model']} extends Model \\{\\n(.*?)\\n\\}\\n/s", $text, $body);
        preg_match_all('/^  declare (\w+):/m', $body[1] ?? '', $declared);
        $names = array_map(static fn(array $c): string => $c['name'], $case['calls']);
        return array_values(array_intersect($names, $declared[1]));
    }

    #[DataProvider('vectors')]
    public function test_the_node_and_the_php_scan_agree(array $case): void
    {
        $dir = self::$work . '/' . $case['id'];
        @mkdir("$dir/src", 0o700, true);
        $node = self::node($case, $dir);
        $receiver = str_replace('{model}', '\\Polyspec\\Orm\\Tests\\Parity\\' . $case['model'], $case['receiver'] ?? '$m');
        $steps = array_map(static fn(array $c): string => "{$c['name']}(" . implode(', ', array_fill(0, $c['args'], '1')) . ')', $case['calls']);
        $calls = ($case['chain'] ?? false) ? "$receiver->" . implode('->', $steps) . ";\n"
            : implode('', array_map(static fn(string $step): string => "$receiver->$step;\n", $steps));
        file_put_contents("$dir/src/usage.php", "<?php\n\$db = null;\n\$m = new Polyspec\\Orm\\Tests\\Parity\\{$case['model']}();\n$calls");
        $stderr = fopen('php://memory', 'w+');
        ob_start();
        $code = OrmGen::run(['gen', '--set', dirname(__DIR__, 3) . '/contracts/fixtures/bench/dbspec-set.json', '--out', "$dir/model", '--namespace', 'Polyspec\\Orm\\Tests\\Parity', '--scan', "$dir/src/usage.php"], $stderr);
        ob_end_clean();
        if (isset($case['expected']['rejected'])) {
            self::assertSame(1, $code, 'php status');
            $declared = $node ?? [];
            $called = array_map(static fn(array $c): string => $c['name'], $case['calls']);
            self::assertSame([], array_values(array_intersect($called, $declared)), 'the node orm-gen declares a name the PHP orm-gen rejects');
            return;
        }
        self::assertSame(0, $code, 'php status');
        preg_match_all('/^ \* @method \S+ (\w+)\(/m', (string) file_get_contents("$dir/model/{$case['model']}.php"), $tags);
        $php = $tags[1];
        sort($php, SORT_STRING);
        self::assertNotNull($node, 'the node orm-gen fails');
        sort($node, SORT_STRING);
        self::assertSame($node, $php, 'declared methods');
    }
}
