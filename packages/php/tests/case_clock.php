<?php

declare(strict_types=1);

/*
 * The time limit the test puts on its own computation is measured in the CPU time the PHP process used (docs/spec/dbspec.md,
 * "Verification"). On a shared machine, wall-clock time includes the time spent waiting while other processes use the CPU, so it does not measure what
 * the code did. The PHP test process runs on one thread.
 * Wall-clock time is only printed alongside.
 */

/**
 * Starts the clock of a case with the CPU time baseline $cpuSeconds. A stuck case is ended by PHPUnit's time limit.
 * (phpunit.xml.dist).
 *
 * @return array{0: array, 1: float} [start, baseline] to give cpuCaseEnd
 */
function cpuCaseBegin(float $cpuSeconds): array
{
    return [caseClockStart(), $cpuSeconds];
}

/**
 * Measures the CPU time of case $id, started by cpuCaseBegin. Performance is only measured and does not fail the test,
 * (AGENTS.md), so CPU time above the baseline only writes a warning line to stderr.
 */
function cpuCaseEnd(string $id, array $clock): void
{
    [$cpuMs, $wallMs] = caseClockElapsed($clock[0]);
    if ($cpuMs > $clock[1] * 1000) {
        caseClockWarning(
            sprintf(
                '%s used %.3f ms of CPU (%.3f ms wall), above its reference of %s s',
                $id,
                $cpuMs,
                $wallMs,
                $clock[1]
            )
        );
    }
}

/**
 * Writes to stderr the line `WARNING <message>; machine ...` that the measurement exceeded the baseline. A warning is
 * not a failure.
 */
function caseClockWarning(string $message): void
{
    fwrite(
        STDERR,
        sprintf("WARNING %s; machine %s %s, PHP %s\n", $message, PHP_OS_FAMILY, php_uname('m'), PHP_VERSION)
    );
}

/** The start of one case: [hrtime ns, process CPU ns]. */
function caseClockStart(): array
{
    return [hrtime(true), processCpuNs()];
}

/** The CPU time and wall-clock time (ms) the process used after the start: [cpuMs, wallMs]. */
function caseClockElapsed(array $start): array
{
    return [(processCpuNs() - $start[1]) / 1e6, (hrtime(true) - $start[0]) / 1e6];
}

/** The user and system CPU time (ns) the PHP process has used so far. */
function processCpuNs(): int
{
    $usage = getrusage();
    if ($usage === false) {
        throw new RuntimeException('getrusage failed');
    }
    return ($usage['ru_utime.tv_sec'] + $usage['ru_stime.tv_sec']) * 1_000_000_000
        + ($usage['ru_utime.tv_usec'] + $usage['ru_stime.tv_usec']) * 1_000;
}
