<?php

declare(strict_types=1);

// 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 PHP dbspec
// 결과를 tests/dbspec/compare/check.mts의 줄 형식으로 출력한다. It then prints the positions cases of cases.json and
// the analysis and format of each case of syntax.json.
//
// Usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>

require __DIR__ . '/../../../vendor-php/autoload.php';
require __DIR__ . '/php-interface.php';

if ($argc !== 7) {
    fwrite(STDERR, "usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json> <syntax.json>\n");
    exit(2);
}

$cases = dbspec_write_interface(Polyspec\Orm\Dbspec\Dbspec::class, $argv[1], $argv[2], $argv[3]);
dbspec_write_plans(Polyspec\Orm\Dbspec\Dbspec::class, $argv[4]);
dbspec_write_mermaid(Polyspec\Orm\Dbspec\Dbspec::class, $argv[5]);
dbspec_write_positions(Polyspec\Orm\Dbspec\Dbspec::class, $cases);
dbspec_write_syntax(Polyspec\Orm\Dbspec\Dbspec::class, $cases, $argv[6]);
