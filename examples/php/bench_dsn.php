<?php

declare(strict_types=1);

/** Returns the seeded bench DSN or explains how to provide it. */
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
