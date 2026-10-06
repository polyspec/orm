<?php

declare(strict_types=1);

// 한 database 를 PHP 확장 orm_dbspec(Polyspec\Orm\Dbspec\Native\Dbspec)으로 introspect 해 PHP client 의 runner(php.php)와
// 같은 형식으로 쓴다: stdout 에 canonical 문서와 미지원 객체 줄 "! kind<TAB>table<TAB>name", stderr 에 "elapsed <ms>".
// DSN 은 PHP client 의 Orm::parseDsn 으로 PDO 인자로 바꾼다.
//
// Usage: php -d extension=<orm_dbspec library> tests/dbspec/introspect/php-extension.php <mysql|postgres|sqlite> <uri>

require __DIR__ . '/../../../clients/php/vendor/autoload.php';

use Polyspec\Orm\Dbspec\Native\Dbspec;
use Polyspec\Orm\Orm;

if ($argc !== 3) {
    fwrite(STDERR, "usage: php -d extension=<orm_dbspec library> tests/dbspec/introspect/php-extension.php <mysql|postgres|sqlite> <uri>\n");
    exit(2);
}
if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run this with php -d extension=<orm_dbspec library>, which make dbspec-introspect-compare-check builds\n");
    exit(1);
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
