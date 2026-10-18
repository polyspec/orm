<?php

declare(strict_types=1);

// Introspects one database with the PHP client and writes the output in the tests/dbspec/introspect format:
// it writes the canonical document and unsupported object lines to stdout
// "! kind<TAB>table<TAB>name", and "elapsed <ms>" to stderr.
//
// Usage: php packages/php/testing/dbspec/introspect/php.php <mysql|postgres|sqlite> <uri>

require __DIR__ . '/../../../../../vendor-php/autoload.php';

use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\Orm;

if ($argc !== 3) {
    fwrite(STDERR, "usage: php packages/php/testing/dbspec/introspect/php.php <mysql|postgres|sqlite> <uri>\n");
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
