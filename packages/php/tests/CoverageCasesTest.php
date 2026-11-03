<?php

// Unit test of the feature coverage helper (packages/php/tests/coverage_cases.php). The helper
// is shared by packages/php/tests/Coverage*Test.php, so a change to it is checked by this
// test (the helpers in contracts/features.json), not by the coverage of all features. Full coverage is run by make
// orm-check.
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use RuntimeException;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use Polyspec\Orm\OrmException;

#[Small]
final class CoverageCasesTest extends TestCase
{
    public function testEntryClassAssertionAllowsLibraryMode(): void
    {
        self::assertNotSame('extension', getenv('ORM_PHP_MODE'), 'this helper unit runs in library mode');
        coverageAssertEntryClassesAreInternal();
    }

    public function testCaseDatabasePreservesTheBodyAndDropFailures(): void
    {
        $path = null;
        $warnings = [];
        $failure = new RuntimeException('case body failed');
        set_error_handler(static function (int $severity, string $message) use (&$warnings, &$path): bool {
            if ($severity === E_WARNING && is_string($path) && str_starts_with($message, "unlink($path):")) {
                $warnings[] = $message;
                return true;
            }
            return false;
        });
        try {
            try {
                with_case_database(
                    'sqlite',
                    static function (string $_step): void {
                    },
                    static function (string $_dsn, CaseDatabase $database) use (&$path, $failure): void {
                        $path = $database->name;
                        self::assertTrue(
                            unlink($database->name),
                            'remove the SQLite case file before replacing it with a directory'
                        );
                        self::assertTrue(
                            mkdir($database->name, 0700),
                            'create a directory that makes database cleanup fail'
                        );
                        throw $failure;
                    },
                );
                self::fail('the case body and database drop failures must be reported');
            } catch (OrmException $caught) {
                self::assertStringContainsString('case body failed', $caught->getMessage());
                self::assertStringContainsString('drop sqlite file', $caught->getMessage());
                self::assertSame(
                    $failure,
                    $caught->getPrevious()?->getPrevious(),
                    'the body throwable remains in the cause chain'
                );
                self::assertCount(1, $caught->cleanup);
                self::assertStringContainsString('unlink failed', $caught->cleanup[0]->getMessage());
            }
        } finally {
            restore_error_handler();
            if (is_string($path) && is_dir($path)) {
                self::assertTrue(rmdir($path), 'remove the directory used to make the drop fail');
            }
        }
        self::assertCount(1, $warnings, 'only the expected directory-unlink warning is handled');
    }

    public function testRunsAChildProcess(): void
    {
        [$status, $stdout, $stderr] = coverageProcess(
            [PHP_BINARY, '-r', 'echo "out"; fwrite(STDERR, "err"); exit(3);'],
            __DIR__
        );
        $this->assertSame([3, 'out', 'err'], [$status, $stdout, $stderr], 'child');
    }

}
