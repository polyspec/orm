<?php
declare(strict_types=1);

/**
 * PHP process 가 지금까지 쓴 user 와 system CPU 시간(ns)이다. graph test 의 제한 시간은 CPU
 * 시간으로 잰다(docs/schema.md). 공유 machine 에서 wall-clock 시간은 다른 process 가 CPU 를
 * 쓰는 동안 기다린 시간도 담는다. PHP test process 는 한 thread 로 돈다.
 */
function processCpuNs(): int
{
    $usage = getrusage();
    if ($usage === false) {
        throw new RuntimeException('getrusage failed');
    }
    return ($usage['ru_utime.tv_sec'] + $usage['ru_stime.tv_sec']) * 1_000_000_000
        + ($usage['ru_utime.tv_usec'] + $usage['ru_stime.tv_usec']) * 1_000;
}
