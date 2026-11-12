<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

// A set path without a directory, whose root is the working directory (docs/spec/dbspec.md "Document sets"): the
// working directory is the state of a process, so no recipe step can state it (FCV-2).
// Requirements: DBS-12.

use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\Dbspec\Dbspec;

#[Small]
class DbspecSetTest extends TestCase
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

    public function testASetPathWithoutADirectoryReadsFromTheWorkingDirectory(): void
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
        $this->assertSame([], $result->errors);
        $this->assertSame([], $result->external);
        $this->assertSame(
            [['shop.dbs', "dbspec 1 shop\n"]],
            array_map(static fn(object $f): array => [$f->path, $f->bytes], $result->documents)
        );
    }
}
