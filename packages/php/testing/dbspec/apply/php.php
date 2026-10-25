<?php

declare(strict_types=1);

// Applies the chains in plans.json (tests/dbspec/plans.json) (create-from-empty and
// rename-table-and-column) to one database with the PHP client
// (docs/spec/plans.md "Apply"). action is one of apply-first (first plan only), apply (whole chain),
// stop (stop after statement 1 of the second plan runs), recover (continue an interrupted plan
// to completion), or rollback (revert the last plan in history). It writes one result line to stdout: "ok", "stopped",
// or "error <code>". Any other error is written to stderr and exits with 1.
//
// Usage: php packages/php/testing/dbspec/apply/php.php <apply-first|apply|stop|recover|rollback|lock-wait>
// <mysql|postgres|sqlite> <uri> <plans.json>

require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../../tests/dbspec/input.php';
require __DIR__ . '/runner.php';

if ($argc !== 5) {
    fwrite(
        STDERR,
        "usage: php packages/php/testing/dbspec/apply/php.php <apply-first|apply|stop|recover|rollback|lock-wait> "
        . "<mysql|postgres|sqlite> <uri> <plans.json>\n"
    );
    exit(2);
}
exit(dbspec_apply_runner_run($argv));
