<?php

// The functions and constants of the thin-slice demo (main.php), which requires this file.
declare(strict_types=1);

const ITERATIONS = 500;

const AES_KEY = 'bench-salt';

require_once dirname(__DIR__, 2) . '/php/bench_dsn.php';

function p50(Closure $f): int
{
    $s = [];
    for ($i = 0; $i < ITERATIONS; $i++) {
        $t = hrtime(true);
        $f();
        $s[] = intdiv(hrtime(true) - $t, 1000);
    }
    sort($s);
    return $s[intdiv(count($s), 2)];
}
