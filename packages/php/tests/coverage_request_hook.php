<?php
// request_hook coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서 공유 case마다
// 새 case database(case_database.php)를 만들어 request_hook_cases.php의 case를 실행하고 지운다.
// ORM_FEATURE_DSN의 database는 읽거나 쓰지 않는다.
declare(strict_types=1);

require __DIR__ . '/request_hook_cases.php';
require_once __DIR__ . '/case_database.php';
require_once __DIR__ . '/coverage_cases.php';

$coverage = [];
foreach (array_keys(REQUEST_HOOK_CASES) as $id) {
    $coverage[$id] = static function () use ($id): void {
        [$driver] = coverageDatabase();
        with_case_database($driver, static function (): void {}, static fn(string $dsn) => runRequestHookCase($id, $dsn));
    };
}
runCoverageCases($argv, $coverage);
