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
    public function test_without_hook(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('without_hook');
        }
    }

    public function test_read_filter(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('read_filter');
        }
    }

    public function test_insert_assign(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('insert_assign');
        }
    }

    public function test_loaded_row_writes(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('loaded_row_writes');
        }
    }

    public function test_invalid_param(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('invalid_param');
        }
    }

    public function test_restore_key(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('restore_key');
        }
    }

    public function test_restore_condition(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('restore_condition');
        }
    }

    public function test_restore_no_key(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('restore_no_key');
        }
    }

    public function test_restore_rewritten_key(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('restore_rewritten_key');
        }
    }

    public function test_restore_hook_set_key(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('restore_hook_set_key');
        }
    }

    public function test_restore_rewritten_key_set_scope(): void
    {
        foreach (coverageItemsOf(__FILE__) as $item) {
            selectCoverageItem($item);
            self::run_case('restore_rewritten_key_set_scope');
        }
    }

    private static function run_case(string $id): void
    {
        [$driver] = coverageItem();
        with_case_database($driver, static function (): void {}, static fn(string $dsn) => runRequestHookCase($id, $dsn));
    }
}
