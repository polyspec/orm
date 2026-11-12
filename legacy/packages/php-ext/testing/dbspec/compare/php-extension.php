<?php

declare(strict_types=1);

// With the PHP extension polyspec_orm (Polyspec\Orm\Dbspec\Dbspec), all shared cases, stress documents, statement
// vectors, plan vectors, and Mermaid recipe results print in the line format of tests/dbspec/compare/check.mts. The
// output is written by the same function as the PHP client's runner (php.php), with the positions cases and the
// analysis of the recipe files of tests/dbspec.
//
// Usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/compare/php-extension.php
// <tests/dbspec dir> <stress document> <ddl.json> <plan-cases.json> <mermaid.json>

require __DIR__ . '/../../../../../tests/dbspec/input.php';
require __DIR__ . '/../../../../../vendor-php/autoload.php';
require __DIR__ . '/../../../../../tests/dbspec/vectors.php';
require __DIR__ . '/../../../../php/tests/dbspec_plan_cases.php';
require __DIR__ . '/../../../../php/testing/dbspec/compare/php-interface.php';

if ($argc !== 6) {
    fwrite(
        STDERR,
        "usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/compare/php-extension.php "
        . "<tests/dbspec dir> <stress document> <ddl.json> <plan-cases.json> <mermaid.json>\n"
    );
    exit(2);
}
if (getenv('ORM_PHP_MODE') !== 'extension') {
    fwrite(
        STDERR,
        "the extension polyspec_orm is not loaded; run this with php -d extension=<polyspec_orm library>, which make "
        . "dbspec-compare-check builds\n"
    );
    exit(1);
}

dbspec_write_comparison(Polyspec\Orm\Dbspec\Dbspec::class, array_slice($argv, 1));
