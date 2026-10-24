<?php

// request_hook coverage: in the case database (ORM_FEATURE_DATABASE) chosen by feature-check, for each shared case,
// creates a new case database (case_database.php), runs the case in request_hook_cases.php, and removes it.
// Does not read or write the database of ORM_FEATURE_DSN. There is one test method per case of REQUEST_HOOK_CASES
// (scripts/features/check.mts compares it with the case list in features.json).
declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
class CoverageRequestHookTest extends TestCase
{
    protected static function coverageTestFile(): string
    {
        return __FILE__;
    }

    // Requirements: INT-78.
    public function testReadsParams(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'orm-request-hook-reads-params-');
        if (!is_string($path)) {
            throw new \RuntimeException('cannot create the request hook SQLite database file');
        }
        try {
            readsParamsCase('sqlite://' . $path);
        } finally {
            unlink($path);
        }
    }

    // Requirements: INT-78.
    public function test_without_hook(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('without_hook');
        }
    }

    // Requirements: INT-78, PRT-2.
    public function test_read_filter(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('read_filter');
        }
    }

    // Requirements: INT-78, PRT-2.
    public function testSameHandleChildHookOnce(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('same_handle_child_hook_once');
        }
    }

    // Requirements: PRT-4, PRT-5, PRT-41.
    public function test_insert_assign(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('insert_assign');
        }
    }

    // Requirements: INT-78, PRT-4, PRT-6.
    public function testUpsertScope(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('upsert_scope');
        }
    }

    // Requirements: CFG-21, INT-36, INT-37, PLN-16.
    public function test_loaded_row_writes(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('loaded_row_writes');
        }
    }

    // Requirements: PRT-65.
    public function test_invalid_param(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('invalid_param');
        }
    }

    // Requirements: DIA-161.
    public function test_restore_key(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_key');
        }
    }

    // Requirements: DIA-161, INT-38.
    public function test_restore_condition(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_condition');
        }
    }

    // Requirements: DIA-161.
    public function test_restore_no_key(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_no_key');
        }
    }

    // Requirements: DIA-161.
    public function test_restore_rewritten_key(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_rewritten_key');
        }
    }

    // Requirements: DIA-161.
    public function test_restore_hook_set_key(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_hook_set_key');
        }
    }

    // Requirements: DIA-161.
    public function test_restore_rewritten_key_set_scope(): void
    {
        foreach (coverageItemsOf(static::coverageTestFile()) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_rewritten_key_set_scope');
        }
    }

    private static function runCase(string $id): void
    {
        [$driver] = coverageItem();
        with_case_database($driver, static function (): void {
        }, static fn(string $dsn) => runRequestHookCase($id, $dsn));
    }
}
