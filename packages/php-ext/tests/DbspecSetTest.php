<?php

declare(strict_types=1);

// The extension's set reader (Polyspec\Orm\Dbspec\Native\Dbspec::readSet) against the shared vectors
// tests/dbspec/set-files.json and the focused cases, each in a temporary file tree with real symbolic and hard
// links. The PHP client is the specification, so on every tree the native result equals the PHP client's: the
// same files and bytes, or the same errors with their rules, paths and messages. The result classes follow the
// PHP client's rules too (SetResult::invalid without an error).

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Dbspec\Native\Dbspec as NativeDbspec;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 2) . '/php/tests/dbspec_set_cases.php';

/** The outcome of $body as [class without namespace, value or message]. */
function set_outcome(callable $body): array
{
    try {
        $value = $body();
        return [is_object($value) ? substr(strrchr('\\' . get_class($value), '\\'), 1) : 'value', json_encode($value instanceof stdClass ? $value : (is_object($value) ? dbspec_set_described($value) : $value), JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)];
    } catch (Throwable $error) {
        return [get_class($error), $error->getMessage()];
    }
}

#[Small]
final class DbspecSetTest extends TestCase
{
    private string $work;

    protected function setUp(): void
    {
        $this->work = sys_get_temp_dir() . '/orm-php-dbspec-set-extension-' . getmypid();
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->work));
    }

    public static function setCases(): iterable
    {
        return dbspec_set_sets(dirname(__DIR__, 3));
    }

    public static function focusedCases(): iterable
    {
        return dbspec_set_focused_sets();
    }

    #[DataProvider('focusedCases')]
    public function test_focused(array $case): void
    {
        $this->test_set($case);
    }

    #[DataProvider('setCases')]
    public function test_set(array $case): void
    {
        dbspec_set_check($case, static fn(string $path): object => NativeDbspec::readSet($path), function (object $native, string $path): void {
            $this->assertSame(dbspec_set_described(Dbspec::readSet($path)), dbspec_set_described($native), 'the extension differs from the PHP client');
            foreach ([$native->documents ?? [], $native->external ?? []] as $files) {
                foreach ($files as $file) {
                    $this->assertInstanceOf(Polyspec\Orm\Dbspec\Native\SetFile::class, $file, 'a file is not a Native\SetFile');
                }
            }
            foreach ($native->errors as $error) {
                $this->assertInstanceOf(Polyspec\Orm\Dbspec\Native\SetError::class, $error, 'an error is not a Native\SetError');
            }
        });
    }

    /** The PHP client's and the extension's operation of each other case. */
    private function classCase(string $name): array
    {
        $work = $this->work;
        $inCwd = static function (callable $read) use ($work): object {
            $previous = getcwd();
            chdir("$work/cwd");
            try {
                return $read('dbspec-set.json');
            } finally {
                chdir($previous);
            }
        };
        return [
            'a set path without a directory' => [
                static fn() => $inCwd(static fn(string $p): object => Dbspec::readSet($p)),
                static fn() => $inCwd(static fn(string $p): object => NativeDbspec::readSet($p)),
            ],
            'a set path with a NUL byte' => [
                static fn() => Dbspec::readSet("$work/a\0b/dbspec-set.json"),
                static fn() => NativeDbspec::readSet("$work/a\0b/dbspec-set.json"),
            ],
            'SetResult::invalid without an error' => [
                static fn() => Polyspec\Orm\Dbspec\SetResult::invalid([]),
                static fn() => Polyspec\Orm\Dbspec\Native\SetResult::invalid([]),
            ],
            'SetResult::invalid' => [
                static fn() => Polyspec\Orm\Dbspec\SetResult::invalid([new Polyspec\Orm\Dbspec\SetError('set.file', 'a', 'a: m')]),
                static fn() => Polyspec\Orm\Dbspec\Native\SetResult::invalid([new Polyspec\Orm\Dbspec\Native\SetError('set.file', 'a', 'a: m')]),
            ],
            'SetResult::valid' => [
                static fn() => Polyspec\Orm\Dbspec\SetResult::valid([new Polyspec\Orm\Dbspec\SetFile('a.dbs', 'x')], []),
                static fn() => Polyspec\Orm\Dbspec\Native\SetResult::valid([new Polyspec\Orm\Dbspec\Native\SetFile('a.dbs', 'x')], []),
            ],
        ][$name];
    }

    public static function classCases(): iterable
    {
        foreach (['a set path without a directory', 'a set path with a NUL byte', 'SetResult::invalid without an error', 'SetResult::invalid', 'SetResult::valid'] as $name) {
            yield "classes/$name" => [$name];
        }
    }

    #[DataProvider('classCases')]
    public function test_classes(string $name): void
    {
        mkdir("{$this->work}/cwd", 0o700, true);
        file_put_contents("{$this->work}/cwd/shop.dbs", "dbspec 1 shop\n");
        file_put_contents("{$this->work}/cwd/dbspec-set.json", '{"schema": 1, "documents": ["shop.dbs"]}');
        [$php, $native] = $this->classCase($name);
        $this->assertSame(set_outcome($php), set_outcome($native));
    }
}
