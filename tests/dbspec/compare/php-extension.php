<?php

declare(strict_types=1);

// PHP 확장 orm_dbspec(Orm\Dbspec\Native\Dbspec)으로 모든 공유 case, stress 문서, statement vector, plan vector,
// Mermaid vector의 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다. 출력은 PHP client의 runner(php.php)와
// 같은 함수로 쓴다.
//
// Usage: php -d extension=<orm_dbspec library> tests/dbspec/compare/php-extension.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>

require __DIR__ . '/php-interface.php';

if ($argc !== 6) {
    fwrite(STDERR, "usage: php -d extension=<orm_dbspec library> tests/dbspec/compare/php-extension.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>\n");
    exit(2);
}
if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run this with php -d extension=<orm_dbspec library>, which make dbspec-compare-check builds\n");
    exit(1);
}

dbspec_write_interface(Orm\Dbspec\Native\Dbspec::class, $argv[1], $argv[2], $argv[3]);
dbspec_write_plans(Orm\Dbspec\Native\Dbspec::class, $argv[4]);
dbspec_write_mermaid(Orm\Dbspec\Native\Dbspec::class, $argv[5]);
