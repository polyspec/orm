<?php
declare(strict_types=1);
// interface_contract feature coverage: 저장소 root에서
// `go run ./tests/interfaces/check -language php`를 실행하고 종료 코드 0을 요구한다.

require __DIR__ . '/coverage_cases.php';

runCoverageCases($argv, [
    'interface_symbols' => function (): void {
        [$status, $stdout, $stderr] = coverageProcess(['go', 'run', './tests/interfaces/check', '-language', 'php'], dirname(__DIR__, 3));
        coverageWant($status === 0, "interface check exited $status: $stderr$stdout");
    },
]);
