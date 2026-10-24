<?php

declare(strict_types=1);

// Introspects one database with the PHP extension polyspec_orm (Polyspec\Orm\Dbspec\Dbspec) and writes it in the same
// format as the PHP client's runner (php.php): on stdout, the canonical document and unsupported object lines "!
// kind<TAB>table<TAB>name", and on stderr "elapsed <ms>". The DSN is converted to PDO arguments with the PHP client's
// Orm::parseDsn.
//
// Usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/introspect/php-extension.php
// <mysql|postgres|sqlite> <uri>

require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../php/testing/dbspec/introspect/runner.php';

if ($argc !== 3) {
    fwrite(
        STDERR,
        "usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/introspect/php-extension.php "
        . "<mysql|postgres|sqlite> <uri>\n"
    );
    exit(2);
}
if (getenv('ORM_PHP_MODE') !== 'extension') {
    fwrite(
        STDERR,
        "the extension polyspec_orm is not loaded; run this with php -d extension=<polyspec_orm library>, which make "
        . "dbspec-introspect-compare-check builds\n"
    );
    exit(1);
}
dbspec_introspect_runner_run($argv[1], $argv[2]);
