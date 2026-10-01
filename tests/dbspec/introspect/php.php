<?php

declare(strict_types=1);

// 한 database 를 PHP client 로 introspect 해 tests/dbspec/introspect 의 출력
// 형식으로 쓴다: stdout 에 canonical 문서와 미지원 객체 줄
// "! kind<TAB>table<TAB>name", stderr 에 "elapsed <ms>".
//
// Usage: php tests/dbspec/introspect/php.php <mysql|postgres|sqlite> <uri>

require __DIR__ . '/../../../clients/php/vendor/autoload.php';

use Orm\Dbspec\Dbspec;
use Orm\Orm;

if ($argc !== 3) {
    fwrite(STDERR, "usage: php tests/dbspec/introspect/php.php <mysql|postgres|sqlite> <uri>\n");
    exit(2);
}
[, $dialect, $uri] = $argv;
[, $pdoDsn, $user, $password] = Orm::parseDsn($uri);
$pdo = new PDO($pdoDsn, $user, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$start = hrtime(true);
$result = Dbspec::introspect($pdo, $dialect, 'introspected');
$elapsed = (hrtime(true) - $start) / 1e6;
$out = Dbspec::emit($result->document);
foreach ($result->unsupported as $u) {
    $out .= "! {$u->kind}\t{$u->table}\t{$u->name}\n";
}
fwrite(STDOUT, $out);
fwrite(STDERR, sprintf("elapsed %.1f\n", $elapsed));
