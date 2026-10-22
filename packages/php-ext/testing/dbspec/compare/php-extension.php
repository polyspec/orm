<?php

declare(strict_types=1);

// With the PHP extension polyspec_orm (Polyspec\Orm\Dbspec\Dbspec), all shared cases, stress documents, statement
// vectors, plan vectors, and Mermaid vector results print in the line format of tests/dbspec/compare/check.mts. The
// output is written by the same function as the PHP client's runner (php.php). It then prints the positions cases of
// cases.json and the analysis and format of each case of syntax.json.
//
// Usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/compare/php-extension.php <cases.json>
// <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>

require __DIR__ . '/../../../../../tests/dbspec/input.php';
require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../../tests/dbspec/vectors.php';
require __DIR__ . '/../../../../../tests/dbspec/cases.php';
require __DIR__ . '/../../../../php/testing/dbspec/compare/php-interface.php';

if ($argc !== 7) {
    fwrite(
        STDERR,
        "usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/compare/php-extension.php "
        . "<cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>\n"
    );
    exit(2);
}
if (!extension_loaded('polyspec_orm')) {
    fwrite(
        STDERR,
        "the extension polyspec_orm is not loaded; run this with php -d extension=<polyspec_orm library>, which make "
        . "dbspec-compare-check builds\n"
    );
    exit(1);
}

$cases = dbspec_write_interface(Polyspec\Orm\Dbspec\Dbspec::class, $argv[1], $argv[2], $argv[3]);
dbspec_write_plans(Polyspec\Orm\Dbspec\Dbspec::class, $argv[4]);
dbspec_write_mermaid(Polyspec\Orm\Dbspec\Dbspec::class, $argv[5]);
dbspec_write_positions(Polyspec\Orm\Dbspec\Dbspec::class, $cases);
dbspec_write_syntax(Polyspec\Orm\Dbspec\Dbspec::class, $cases, $argv[6]);
