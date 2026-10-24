<?php

declare(strict_types=1);

// Introspects one database with the PHP client and writes the output in the tests/dbspec/introspect format:
// it writes the canonical document and unsupported object lines to stdout
// "! kind<TAB>table<TAB>name", and "elapsed <ms>" to stderr.
//
// Usage: php packages/php/testing/dbspec/introspect/php.php <mysql|postgres|sqlite> <uri>

require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/runner.php';

if ($argc !== 3) {
    fwrite(STDERR, "usage: php packages/php/testing/dbspec/introspect/php.php <mysql|postgres|sqlite> <uri>\n");
    exit(2);
}
dbspec_introspect_runner_run($argv[1], $argv[2]);
