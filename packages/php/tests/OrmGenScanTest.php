<?php
// orm-gen --scan test: the generator declares, as @method tags of the model class, the chain methods that the scanned
// PHP sources call on a model (tests/generator/php-scan-vectors.json), resolves the receiver of a call from the source,
// rejects a name or an argument count the chain grammar does not accept, and leaves PHPStan with no method.notFound.
// Usage: packages/php/vendor/bin/phpunit --configuration packages/php/phpunit.xml.dist packages/php/tests/OrmGenScanTest.php
declare(strict_types=1);

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmGen;

#[Small]
final class OrmGenScanTest extends TestCase
{
    private const NS = 'Polyspec\\Orm\\Tests\\Scanned';

    private static string $work;

    public static function setUpBeforeClass(): void
    {
        self::$work = sys_get_temp_dir() . '/orm-php-orm-gen-scan-' . getmypid();
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
            $out[$case['id']] = [$case];
        }
        return $out;
    }

    /** Generates the models of schema/dbspec-set.json with --scan of $sources in a new folder; returns the code, stderr and the folder. */
    private static function generate(string $name, array $sources, array $extra = []): array
    {
        $dir = self::$work . '/' . $name;
        @mkdir("$dir/src", 0o700, true);
        $scan = [];
        foreach ($sources as $file => $text) {
            file_put_contents("$dir/src/$file", $text);
            $scan[] = '--scan';
            $scan[] = "$dir/src/$file";
        }
        $stderr = fopen('php://memory', 'w+');
        ob_start();
        $code = OrmGen::run(['gen', '--set', dirname(__DIR__, 3) . '/schema/dbspec-set.json', '--out', "$dir/model", '--namespace', self::NS, ...$scan, ...$extra], $stderr);
        ob_end_clean();
        rewind($stderr);
        return [$code, (string) stream_get_contents($stderr), $dir];
    }

    /** @return list<string> the methods the class comment of a model declares with @method, in file order */
    private static function tags(string $dir, string $class): array
    {
        preg_match_all('/^ \* @method \S+ (\w+)\(/m', (string) file_get_contents("$dir/model/$class.php"), $m);
        return $m[1];
    }

    #[DataProvider('vectors')]
    public function test_vector(array $case): void
    {
        $args = fn(int $n): string => implode(', ', array_fill(0, $n, '1'));
        $calls = '';
        foreach ($case['calls'] as $call) {
            $calls .= "\$m->{$call['name']}({$args($call['args'])});\n";
        }
        $source = "<?php\nuse " . self::NS . "\\{$case['model']};\n\n\$m = new {$case['model']}();\n$calls";
        [$code, $err, $dir] = self::generate('vector-' . $case['id'], ['usage.php' => $source]);
        if (isset($case['expected']['rejected'])) {
            self::assertSame(1, $code, $case['id'] . ' status');
            self::assertStringContainsString($case['expected']['rejected'], $err, $case['id']);
            self::assertFileDoesNotExist("$dir/model/{$case['model']}.php", 'a rejected generation writes nothing');
            return;
        }
        self::assertSame(0, $code, $case['id'] . ': ' . $err);
        $declared = self::tags($dir, $case['model']);
        sort($declared, SORT_STRING);
        self::assertSame($case['expected']['declared'], $declared, $case['id']);
    }

    public function test_the_receiver_is_resolved_from_the_source(): void
    {
        $ns = self::NS;
        $source = <<<PHP
<?php
namespace App;

use $ns\\Author as A;
use $ns\\User;
use $ns;

class Other
{
    public function geReadCount(int \$n): int { return \$n; }
}

function typed(A \$a, ?User \$u): void
{
    \$a->ltSeq(1);
    \$u?->lkName('x');
}

function made(): A
{
    return new A();
}

function chained(): void
{
    \$q = new A();
    \$q->andGtReadCount(1)->orLeUserSeq(2);
    made()->neServiceSeq(3);
    (new User())->gtSeq(4);
    \$q->and(fn(A \$m) => \$m->ltEndDt('2020-01-01'));
    \$q->or(function (\$m) { \$m->neName('n'); });
    foreach (\$q->gets() as \$row) {
        \$row->geLikeCount(5);
    }
    \$one = \$q->getBySeq(1);
    \$one->ltSuccessCount(6);
    (new \\$ns\\Service())->ltSeq(7);
}

function other(): void
{
    \$o = new Other();
    \$o->geReadCount(1);
    \$o->notAModelMethod(1);
    \$x = new \\stdClass();
    \$x->ltBogus(1);
}
PHP;
        [$code, $err, $dir] = self::generate('receivers', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        $author = self::tags($dir, 'Author');
        sort($author, SORT_STRING);
        self::assertSame(['andGtReadCount', 'geLikeCount', 'getBySeq', 'ltEndDt', 'ltSeq', 'ltSuccessCount', 'neName', 'neServiceSeq', 'orLeUserSeq'], $author, 'Author');
        $user = self::tags($dir, 'User');
        sort($user, SORT_STRING);
        self::assertSame(['gtSeq', 'lkName'], $user, 'User');
        self::assertSame(['ltSeq'], self::tags($dir, 'Service'), 'Service');
    }

    public function test_a_directory_is_scanned_and_a_file_that_does_not_parse_fails_the_scan(): void
    {
        $dir = self::$work . '/directory';
        @mkdir("$dir/src/nested", 0o700, true);
        file_put_contents("$dir/src/nested/a.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n");
        file_put_contents("$dir/src/notes.txt", "ltIgnored(");
        $run = function (string $out) use ($dir): array {
            $stderr = fopen('php://memory', 'w+');
            ob_start();
            $code = OrmGen::run(['gen', '--set', dirname(__DIR__, 3) . '/schema/dbspec-set.json', '--out', $out, '--namespace', self::NS, '--scan', "$dir/src"], $stderr);
            ob_end_clean();
            rewind($stderr);
            return [$code, (string) stream_get_contents($stderr)];
        };
        [$code, $err] = $run("$dir/model");
        self::assertSame(0, $code, $err);
        self::assertSame(['ltSeq'], self::tags($dir, 'Author'));
        file_put_contents("$dir/src/broken.php", "<?php\n\$a = new (;\n");
        [$code, $err] = $run("$dir/model2");
        self::assertSame(1, $code);
        self::assertStringContainsString('broken.php', $err);
    }

    public function test_a_scanned_directory_skips_its_dependencies_and_refuses_a_symlink(): void
    {
        $dir = self::$work . '/links';
        mkdir("$dir/src/vendor/pkg", 0o700, true);
        file_put_contents("$dir/src/a.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n");
        file_put_contents("$dir/src/vendor/pkg/b.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->gtSeq(1);\n");
        $run = function (string $out) use ($dir): array {
            $stderr = fopen('php://memory', 'w+');
            ob_start();
            $code = OrmGen::run(['gen', '--set', dirname(__DIR__, 3) . '/schema/dbspec-set.json', '--out', $out, '--namespace', self::NS, '--scan', "$dir/src"], $stderr);
            ob_end_clean();
            rewind($stderr);
            return [$code, (string) stream_get_contents($stderr)];
        };
        [$code, $err] = $run("$dir/model");
        self::assertSame(0, $code, $err);
        self::assertSame(['ltSeq'], self::tags($dir, 'Author'));
        mkdir("$dir/elsewhere", 0o700, true);
        file_put_contents("$dir/elsewhere/c.php", "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->geSeq(1);\n");
        symlink("$dir/elsewhere", "$dir/src/linked");
        [$code, $err] = $run("$dir/model2");
        self::assertSame(1, $code);
        self::assertStringContainsString("$dir/src/linked is a symlink", $err);
    }

    public function test_check_compares_the_models_with_the_scan(): void
    {
        $source = "<?php\n\$a = new " . self::NS . "\\Author();\n\$a->ltSeq(1);\n";
        [$code, $err, $dir] = self::generate('check', ['usage.php' => $source]);
        self::assertSame(0, $code, $err);
        $stderr = fopen('php://memory', 'w+');
        ob_start();
        $args = ['gen', '--set', dirname(__DIR__, 3) . '/schema/dbspec-set.json', '--out', "$dir/model", '--namespace', self::NS, '--scan', "$dir/src/usage.php", '--check'];
        self::assertSame(0, OrmGen::run($args, $stderr), 'current');
        self::assertSame('', (string) ob_get_clean());
        file_put_contents("$dir/src/usage.php", $source . "\$a->gtSeq(1);\n");
        ob_start();
        self::assertSame(1, OrmGen::run($args, $stderr), 'stale');
        self::assertSame("differs: $dir/model/Author.php\n", (string) ob_get_clean());
    }

    public function test_phpstan_finds_every_scanned_chain_method(): void
    {
        $root = dirname(__DIR__, 3);
        $ns = self::NS;
        $used = <<<PHP
<?php
declare(strict_types=1);

use $ns\\Author;
use $ns\\User;

function calls(Author \$a, User \$u): Author
{
    \$a->ltSeq(1)->andGeReadCount(2)->orNeIsClose(true)->lkName('n')->seqAndName(1, 'a')->betweenReadCount([1, 5]);
    \$a->gtStartDt(\\Polyspec\\Orm\\Func::class === '' ? new DateTimeImmutable() : new DateTimeImmutable());
    \$a->getsBySeqAndIsClose(1, false);
    \$a->orderBySeqDescAndNameAsc()->joinUserSeqWithSeq(\$u)->tupleUserSeqWithServiceSeq([[1, 2]]);
    \$a->aliasMine()->newExtra(1)->possibleSeq(1);
    \$u->neName('x');
    return \$a;
}
PHP;
        [$code, $err, $dir] = self::generate('phpstan', ['usage.php' => $used]);
        self::assertSame(0, $code, $err);
        file_put_contents("$dir/models.php", "<?php\nspl_autoload_register(static function (string \$class): void {\n"
            . "    \$prefix = '" . addslashes($ns) . "\\\\';\n"
            . "    if (str_starts_with(\$class, \$prefix)) {\n        require " . var_export("$dir/model/", true) . " . substr(\$class, strlen(\$prefix)) . '.php';\n    }\n});\n");
        file_put_contents("$dir/autoload.php", "<?php\nrequire " . var_export("$root/packages/php/tests/autoload.php", true) . ";\nrequire " . var_export("$dir/models.php", true) . ";\n");
        file_put_contents("$dir/phpstan.neon", "parameters:\n    tmpDir: $dir/phpstan-cache\n");
        // A call that the sources of the scan do not make is not declared: the control that makes the zero meaningful.
        file_put_contents("$dir/control.php", "<?php\ndeclare(strict_types=1);\n\nfunction control(\\$ns\\Author \$a): void\n{\n    \$a->ltReadCount(1);\n}\n");
        $analyse = function (string $file) use ($root, $dir): array {
            $command = [PHP_BINARY, "$root/vendor-php/bin/phpstan", 'analyse', '--no-progress', '--no-ansi', '--error-format=raw',
                '--configuration', "$dir/phpstan.neon", '--level=9', '--memory-limit=512M', '--autoload-file', "$dir/autoload.php", $file];
            $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root);
            $out = (string) stream_get_contents($pipes[1]);
            $err = (string) stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $status = proc_close($process);
            // PHPStan exits 0 without errors and 1 with errors; any other status is a run that did not analyse.
            self::assertContains($status, [0, 1], "phpstan analyse $file exited with $status:\n$out$err");
            return [array_values(array_filter(explode("\n", $out), static fn(string $line): bool => str_contains($line, '[identifier='))), $out . $err, $status];
        };
        [$findings, $raw] = $analyse("$dir/src/usage.php");
        $notFound = array_values(array_filter($findings, static fn(string $line): bool => str_contains($line, 'method.notFound')));
        self::assertSame([], $notFound, "method.notFound:\n" . implode("\n", $notFound) . "\n$raw");
        [$control, $controlRaw, $controlStatus] = $analyse("$dir/control.php");
        self::assertSame(1, $controlStatus, "the control call is declared:\n$controlRaw");
        self::assertNotSame([], array_filter($control, static fn(string $line): bool => str_contains($line, 'method.notFound')), "the control call is declared:\n$controlRaw");
    }
}
