<?php
// request_hook coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서 공유 case마다
// 새 case database(case_database.php)를 만들어 request_hook_cases.php의 case를 실행하고 지운다.
// ORM_FEATURE_DSN의 database는 읽거나 쓰지 않는다. test method는 REQUEST_HOOK_CASES의 case마다 하나다
// (scripts/features/check.mts가 features.json의 case 목록과 비교한다).
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
        self::run_case('without_hook');
    }

    public function test_read_filter(): void
    {
        self::run_case('read_filter');
    }

    public function test_insert_assign(): void
    {
        self::run_case('insert_assign');
    }

    public function test_loaded_row_writes(): void
    {
        self::run_case('loaded_row_writes');
    }

    public function test_invalid_param(): void
    {
        self::run_case('invalid_param');
    }

    public function test_restore_key(): void
    {
        self::run_case('restore_key');
    }

    public function test_restore_condition(): void
    {
        self::run_case('restore_condition');
    }

    public function test_restore_no_key(): void
    {
        self::run_case('restore_no_key');
    }

    public function test_restore_rewritten_key(): void
    {
        self::run_case('restore_rewritten_key');
    }

    public function test_restore_hook_set_key(): void
    {
        self::run_case('restore_hook_set_key');
    }

    private static function run_case(string $id): void
    {
        [$driver] = coverageDatabase();
        with_case_database($driver, static function (): void {}, static fn(string $dsn) => runRequestHookCase($id, $dsn));
    }
}
