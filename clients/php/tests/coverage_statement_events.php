<?php
// statement_events coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서
// tests/events/vectors.json의 모든 case를 case마다 새 case database(case_database.php)로
// 실행하고 기대 event와 비교한다. bench database는 읽거나 쓰지 않는다.
declare(strict_types=1);

require __DIR__ . '/statement_events_run.php';
require_once __DIR__ . '/coverage_cases.php';

runCoverageCases($argv, [
    'statement_events' => static function () use ($vector): void {
        [$driver] = coverageDatabase();
        foreach ($vector['cases'] as $case) {
            $GLOBALS['current'] = "{$case['id']}/$driver";
            with_case_database($driver, static function (): void {}, static fn(string $dsn) => runCase($case, $driver, $dsn));
        }
        if ($GLOBALS['failures'] > 0) {
            throw new RuntimeException($GLOBALS['failures'] . ' check(s) failed; each FAIL line names one');
        }
    },
]);
