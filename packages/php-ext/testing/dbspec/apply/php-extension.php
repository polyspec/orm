<?php

declare(strict_types=1);

// Applies the chain of plans.json (tests/dbspec/plans.json), create-from-empty and
// rename-table-and-column, to one database with the PHP extension polyspec_orm (Polyspec\Orm\Dbspec)
// (docs/spec/plans.md "Apply"). action is one of apply-first (first plan only), apply (whole chain),
// stop (stops after statement 1 of the second plan runs), recover (finishes the interrupted plan),
// rollback (reverts the last plan in history). stdout gets one result line: "ok", "stopped", or
// "error <code>". Any other error is written to stderr and exits with 1.
//
// The DSN is converted to PDO arguments with the PHP client's Orm::parseDsn.
//
// Usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/apply/php-extension.php
// <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>

require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../../tests/dbspec/input.php';
require __DIR__ . '/../../../../php/testing/dbspec/apply/runner.php';

if ($argc !== 5) {
    fwrite(
        STDERR,
        "usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/apply/php-extension.php "
        . "<apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>\n"
    );
    exit(2);
}
if (getenv('ORM_PHP_MODE') !== 'extension') {
    fwrite(
        STDERR,
        "the extension polyspec_orm is not loaded; run this with php -d extension=<polyspec_orm library>, which make "
        . "dbspec-apply-pairs-check builds\n"
    );
    exit(1);
}
exit(dbspec_apply_runner_run($argv));
