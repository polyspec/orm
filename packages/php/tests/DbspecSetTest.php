<?php
declare(strict_types=1);
// The set reader Dbspec::readSet (docs/dbspec.md "Document sets") through the shared vectors
// tests/dbspec/set-files.json and the cases they cannot state: a set path without a directory, whose root
// is the working directory, and a set path with a NUL byte.
require_once __DIR__ . '/dbspec_set_cases.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

#[Small]
final class DbspecSetTest extends TestCase
{
    private string $work;

    protected function setUp(): void
    {
        $this->work = sys_get_temp_dir() . '/orm-php-dbspec-set-focused-' . getmypid();
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->work));
    }

    public static function setCases(): iterable
    {
        return dbspec_set_sets(dirname(__DIR__, 3));
    }

    #[DataProvider('setCases')]
    public function test_set(array $case): void
    {
        dbspec_set_check($case, static fn(string $path): object => Dbspec::readSet($path));
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

    public function test_a_set_path_without_a_directory_reads_from_the_working_directory(): void
    {
        mkdir("{$this->work}/cwd", 0o700, true);
        file_put_contents("{$this->work}/cwd/shop.dbs", "dbspec 1 shop\n");
        file_put_contents("{$this->work}/cwd/dbspec-set.json", '{"schema": 1, "documents": ["shop.dbs"]}');
        $previous = getcwd();
        chdir("{$this->work}/cwd");
        try {
            $result = Dbspec::readSet('dbspec-set.json');
        } finally {
            chdir($previous);
        }
        $this->assertSame(['documents' => [['shop.dbs', "dbspec 1 shop\n"]], 'external' => [], 'errors' => []], dbspec_set_described($result));
    }

    public function test_a_set_path_with_a_NUL_byte_is_a_set_file_error(): void
    {
        $path = "{$this->work}/a\0b/dbspec-set.json";
        $result = Dbspec::readSet($path);
        $this->assertNull($result->documents);
        $this->assertSame([['set.file', $path]], array_map(static fn(object $e): array => [$e->rule, $e->path], $result->errors));
    }
}
