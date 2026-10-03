<?php
declare(strict_types=1);

/*
 * test가 자기 계산에 두는 시간 제한은 PHP process가 쓴 CPU 시간으로 잰다(docs/dbspec.md,
 * "Verification"). 공유 machine에서 wall-clock 시간은 다른 process가 CPU를 쓰는 동안 기다린
 * 시간도 담으므로 code가 한 일을 재지 못한다. PHP test process는 한 thread로 돈다.
 * wall-clock 시간은 함께 출력만 한다.
 */

require_once dirname(__DIR__, 3) . '/tests/testcase.php';

/**
 * CPU 시간 한도 $cpuSeconds를 가진 case $id를 시작한다(tests/testcase.php의 구역 case).
 * 멈춘 case를 끝내는 wall-clock 기한은 CPU 한도의 열 배다. timing-check가 process group에
 * CPU의 10분의 1만 주므로 그 아래에서도 CPU 한도만 판정한다.
 *
 * @return array{0: array, 1: float} cpuCaseEnd에 줄 [시작, 한도]
 */
function cpuCaseBegin(string $id, float $cpuSeconds): array
{
    testcase_begin($id, 10 * $cpuSeconds);
    return [caseClockStart(), $cpuSeconds];
}

/** cpuCaseBegin으로 시작한 case가 CPU 한도 안에 끝났는지 확인하고 PASS로 끝낸다. */
function cpuCaseEnd(string $id, array $clock): void
{
    [$cpuMs, $wallMs] = caseClockElapsed($clock[0]);
    if ($cpuMs > $clock[1] * 1000) {
        throw new RuntimeException("$id: CPU deadline of {$clock[1]} s exceeded ($cpuMs ms CPU, $wallMs ms wall)");
    }
    testcase_step(sprintf('cpu %.3f ms', $cpuMs));
    testcase_end();
}

/** 한 case의 시작: [hrtime ns, process CPU ns]. */
function caseClockStart(): array
{
    return [hrtime(true), processCpuNs()];
}

/** 시작 뒤 process가 쓴 CPU 시간과 wall-clock 시간(ms): [cpuMs, wallMs]. */
function caseClockElapsed(array $start): array
{
    return [(processCpuNs() - $start[1]) / 1e6, (hrtime(true) - $start[0]) / 1e6];
}

/** PHP process가 지금까지 쓴 user와 system CPU 시간(ns)이다. */
function processCpuNs(): int
{
    $usage = getrusage();
    if ($usage === false) {
        throw new RuntimeException('getrusage failed');
    }
    return ($usage['ru_utime.tv_sec'] + $usage['ru_stime.tv_sec']) * 1_000_000_000
        + ($usage['ru_utime.tv_usec'] + $usage['ru_stime.tv_usec']) * 1_000;
}
