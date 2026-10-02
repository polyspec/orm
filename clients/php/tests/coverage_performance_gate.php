<?php
declare(strict_types=1);
// performance_gate feature coverage: clients/php/tests/perf_gate.php를 자식
// process로 실행하고 종료 코드 0일 때만 통과한다. gate의 출력은 CASE 출력에
// 넣지 않고, 실패하면 오류에 담는다. ORM_BENCH_MYSQL_DSN은 seed된 공유 bench
// database이며 gate는 읽기만 한다.

require __DIR__ . '/coverage_cases.php';

runCoverageCases($argv, [
    'hot_path_gate' => function (): void {
        $dsn = getenv('ORM_BENCH_MYSQL_DSN');
        if (!is_string($dsn) || $dsn === '') {
            throw new RuntimeException('ORM_BENCH_MYSQL_DSN is required');
        }
        [$status, $stdout, $stderr] = coverageProcess([PHP_BINARY, __DIR__ . '/perf_gate.php'], dirname(__DIR__, 3));
        if ($status !== 0) {
            throw new RuntimeException(str_replace($dsn, '[dsn]', "perf_gate.php exited $status: $stdout$stderr"));
        }
    },
]);
