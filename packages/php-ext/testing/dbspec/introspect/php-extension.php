<?php

declare(strict_types=1);

// Introspects one database with the PHP extension polyspec_orm (Polyspec\Orm\Dbspec\Dbspec) and writes it in the same
// format as the PHP client's runner (php.php): on stdout, the canonical document and unsupported object lines "!
// kind<TAB>table<TAB>name", and on stderr "elapsed <ms>". The DSN is converted to PDO arguments with the PHP client's
// Orm::parseDsn.
//
// Usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/introspect/php-extension.php
// <mysql|postgres|sqlite> <uri>

require __DIR__ . '/../../../../../vendor-php/autoload.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;

if ($argc !== 3) {
    fwrite(
        STDERR,
        "usage: php -d extension=<polyspec_orm library> packages/php-ext/testing/dbspec/introspect/php-extension.php "
        . "<mysql|postgres|sqlite> <uri>\n"
    );
    exit(2);
}
if (!extension_loaded('polyspec_orm')) {
    fwrite(
        STDERR,
        "the extension polyspec_orm is not loaded; run this with php -d extension=<polyspec_orm library>, which make "
        . "dbspec-introspect-compare-check builds\n"
    );
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
