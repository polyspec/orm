<?php

// request_hook coverage: in the case database (ORM_FEATURE_DATABASE) chosen by feature-check, for each shared case,
// creates a new case database (case_database.php), runs the case in request_hook_cases.php, and removes it.
// Does not read or write the database of ORM_FEATURE_DSN. There is one test method per case of REQUEST_HOOK_CASES
// (scripts/features/check.mts compares it with the case list in features.json).
declare(strict_types=1);

require_once __DIR__ . '/request_hook_cases.php';
require_once __DIR__ . '/case_database.php';
require_once __DIR__ . '/coverage_cases.php';

use PHPUnit\Framework\Attributes\Medium;
use PHPUnit\Framework\TestCase;

#[Medium]
final class CoverageRequestHookTest extends TestCase
{
    // Requirements: CFG-9.
    public function testWithoutHook(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('without_hook');
        }
    }

    // Requirements: DSL-65, PRT-2.
    public function testReadFilter(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('read_filter');
        }
    }

    // Requirements: PRT-4, PRT-5, PRT-41.
    public function testInsertAssign(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('insert_assign');
        }
    }

    // Requirements: CFG-21, INT-36, INT-37, PLN-16.
    public function testLoadedRowWrites(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('loaded_row_writes');
        }
    }

    // Requirements: PRT-65.
    public function testInvalidParam(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('invalid_param');
        }
    }

    // Requirements: DIA-161.
    public function testRestoreKey(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_key');
        }
    }

    // Requirements: DIA-161, INT-38.
    public function testRestoreCondition(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_condition');
        }
    }

    // Requirements: DIA-161.
    public function testRestoreNoKey(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_no_key');
        }
    }

    // Requirements: DIA-161.
    public function testRestoreRewrittenKey(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_rewritten_key');
        }
    }

    // Requirements: DIA-161.
    public function testRestoreHookSetKey(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::runCase('restore_hook_set_key');
        }
    }

    // Requirements: DIA-161.
    public function testRestoreRewrittenKeySetScope(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
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
