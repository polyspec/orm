<?php

declare(strict_types=1);

// With the PHP extension orm_dbspec (Polyspec\Orm\Dbspec\Native\Dbspec), all shared cases, stress documents, statement vectors, plan vectors,
// and Mermaid vector results print in the line format of tests/dbspec/compare/check.mts. The output
// is written by the same function as the PHP client's runner (php.php). It then prints the positions cases of cases.json and the analysis and format of each case of
// syntax.json.
//
// Usage: php -d extension=<orm_dbspec library> packages/php-ext/testing/dbspec/compare/php-extension.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>

require __DIR__ . '/../../../../php/testing/dbspec/compare/php-interface.php';

if ($argc !== 7) {
    fwrite(STDERR, "usage: php -d extension=<orm_dbspec library> packages/php-ext/testing/dbspec/compare/php-extension.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>\n");
    exit(2);
}
if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run this with php -d extension=<orm_dbspec library>, which make dbspec-compare-check builds\n");
    exit(1);
}

$cases = dbspec_write_interface(Polyspec\Orm\Dbspec\Native\Dbspec::class, $argv[1], $argv[2], $argv[3]);
dbspec_write_plans(Polyspec\Orm\Dbspec\Native\Dbspec::class, $argv[4]);
dbspec_write_mermaid(Polyspec\Orm\Dbspec\Native\Dbspec::class, $argv[5]);
dbspec_write_positions(Polyspec\Orm\Dbspec\Native\Dbspec::class, $cases);
dbspec_write_syntax(Polyspec\Orm\Dbspec\Native\Dbspec::class, $cases, $argv[6]);
