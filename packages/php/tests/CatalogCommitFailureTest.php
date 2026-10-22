<?php

// The commit of a catalog write that the database does not confirm: its outcome is unknown, and a failed ROLLBACK that
// ends the server transaction is reported with it. The private commitFailed is called directly, because a real database
// cannot be made to fail its commit and its rollback in the same way.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Catalog;
use Polyspec\Orm\Code;
use Polyspec\Orm\OrmException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

#[Small]
final class CatalogCommitFailureTest extends TestCase
{
    private string $path = '';

    protected function setUp(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'catalog-commit-');
        self::assertIsString($path, 'tempnam could not create a file in the system temporary directory');
        $this->path = $path;
    }

    protected function tearDown(): void
    {
        unlink($this->path);
    }

    /** Calls the private commitFailed of a catalog on the given connection, with the commit error. */
    private function commitFailed(\PDO $pdo, \PDOException $commitError): void
    {
        $catalog = Catalog::connect('sqlite://' . $this->path);
        try {
            (new ReflectionMethod(Catalog::class, 'commitFailed'))->invoke($catalog, $pdo, $commitError);
        } finally {
            $catalog->close();
        }
    }

    public function testUnknownCommitWithRollbackThatSucceedsReportsTheCommitError(): void
    {
        $pdo = new class extends \PDO {
            public function __construct()
            {
                parent::__construct('sqlite::memory:');
            }

            public function exec(string $statement): int|false
            {
                return 0;
            }
        };
        try {
            $this->commitFailed($pdo, new \PDOException('commit lost'));
            self::fail('an unknown commit outcome was not reported');
        } catch (OrmException $e) {
            self::assertSame(Code::ROW_COMMIT_INDETERMINATE, $e->code_);
            self::assertStringNotContainsString('rollback failed', $e->getMessage());
            self::assertInstanceOf(OrmException::class, $e->getPrevious());
            self::assertStringContainsString('commit lost', $e->getPrevious()->getMessage());
        }
    }

    public function testFailedRollbackIsReportedAsTheCauseOfTheUnknownCommit(): void
    {
        $pdo = new class extends \PDO {
            public function __construct()
            {
                parent::__construct('sqlite::memory:');
            }

            public function exec(string $statement): int|false
            {
                if ($statement === 'ROLLBACK') {
                    throw new \PDOException('rollback refused');
                }
                return 0;
            }
        };
        try {
            $this->commitFailed($pdo, new \PDOException('commit lost'));
            self::fail('a failed rollback after an unknown commit was not reported');
        } catch (OrmException $e) {
            self::assertSame(Code::ROW_COMMIT_INDETERMINATE, $e->code_);
            self::assertStringContainsString('commit outcome unknown; do not retry', $e->getMessage());
            self::assertStringContainsString('rollback failed', $e->getMessage());
            self::assertInstanceOf(OrmException::class, $e->getPrevious());
            self::assertStringContainsString('rollback refused', $e->getPrevious()->getMessage());
        }
    }
}
