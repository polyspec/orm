<?php
declare(strict_types=1);

/** A DSN variable of the test servers' environment; unset fails with its name, and a database test never skips. */
function requiredDsn(string $name): string
{
    $value = getenv($name);
    if (!is_string($value) || $value === '') {
        throw new RuntimeException("$name is not set; run the test through make orm-test-servers or its make target");
    }
    return $value;
}
