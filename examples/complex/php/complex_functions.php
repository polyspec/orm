<?php

// The functions of the complex statement example (main.php), which requires this file.
declare(strict_types=1);

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
