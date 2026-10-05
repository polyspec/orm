<?php

declare(strict_types=1);

// PHP 확장 orm_dbspec(Orm\Dbspec\Native\Dbspec)으로 dbspec 인터페이스의 공유 case, stress 문서, 파일 읽기,
// manifest와 statement vector의 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다. 확장은
// Plan과 Mermaid component를 구현하지 않으므로 plan vector와 Mermaid vector는 받지 않는다. 출력은 첫 Go
// 출력의 첫 plan case 앞까지와 같아야 한다(runners.mjs의 until).
//
// Usage: php -d extension=<orm_dbspec library> tests/dbspec/compare/php-extension.php <cases.json> <stress document> <ddl.json>

require __DIR__ . '/php-interface.php';

if ($argc !== 4) {
    fwrite(STDERR, "usage: php -d extension=<orm_dbspec library> tests/dbspec/compare/php-extension.php <cases.json> <stress document> <ddl.json>\n");
    exit(2);
}
if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run this with php -d extension=<orm_dbspec library>, which make dbspec-compare-check builds\n");
    exit(1);
}

dbspec_write_interface(Orm\Dbspec\Native\Dbspec::class, $argv[1], $argv[2], $argv[3]);
