<?php
declare(strict_types=1);

/*
 * test가 자기 계산에 두는 시간 제한은 PHP process가 쓴 CPU 시간으로 잰다(docs/dbspec.md,
 * "Verification"). 공유 machine에서 wall-clock 시간은 다른 process가 CPU를 쓰는 동안 기다린
 * 시간도 담으므로 code가 한 일을 재지 못한다. PHP test process는 한 thread로 돈다.
 * wall-clock 시간은 함께 출력만 한다.
 */

/**
 * CPU 시간 기준값 $cpuSeconds를 가진 case의 시계를 시작한다. 멈춘 case는 PHPUnit의 시간 제한이 끝낸다
 * (phpunit.xml.dist).
 *
 * @return array{0: array, 1: float} cpuCaseEnd에 줄 [시작, 기준값]
 */
function cpuCaseBegin(float $cpuSeconds): array
{
    return [caseClockStart(), $cpuSeconds];
}

/**
 * cpuCaseBegin으로 시작한 case $id의 CPU 시간을 잰다. 성능은 측정할 뿐 test를 실패시키지 않으므로
 * (AGENTS.md), 기준값을 넘은 CPU 시간은 stderr에 경고 줄만 쓴다.
 */
function cpuCaseEnd(string $id, array $clock): void
{
    [$cpuMs, $wallMs] = caseClockElapsed($clock[0]);
    if ($cpuMs > $clock[1] * 1000) {
        caseClockWarning(sprintf('%s used %.3f ms of CPU (%.3f ms wall), above its reference of %s s', $id, $cpuMs, $wallMs, $clock[1]));
    }
}

/** 성능 측정이 기준값을 넘었다는 줄 `WARNING <message>; machine ...`를 stderr에 쓴다. 경고는 실패가 아니다. */
function caseClockWarning(string $message): void
{
    fwrite(STDERR, sprintf("WARNING %s; machine %s %s, PHP %s\n", $message, PHP_OS_FAMILY, php_uname('m'), PHP_VERSION));
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
