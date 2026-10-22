<?php

// The functions and constants of the thin-slice demo (main.php), which requires this file.
declare(strict_types=1);

const ITERATIONS = 500;

const AES_KEY = 'bench-salt';

/** ORM_BENCH_MYSQL_DSN points to the seeded bench database. If it is missing or empty, it ends without connecting. */
function dsn(): string
{
    $dsn = getenv('ORM_BENCH_MYSQL_DSN');
    if ($dsn === false || $dsn === '') {
        fwrite(
            STDERR,
            "ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make orm-check or "
            . "make run-databases TARGETS=<target>, which create the bench database of the run\n"
        );
        exit(1);
    }
    return $dsn;
}

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
