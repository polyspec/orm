<?php
// One side of the deadlock test in model_test.php. Inside transaction(): update the first row,
// print "locked", wait for a line on stdin, then update the second row. The other side runs with
// the rows swapped, so the database reports a deadlock to one of them and transaction() runs the
// closure again. Prints "done <closure runs>".
// Usage: php deadlock_child.php <dsn> <schema.json> <first seq> <second seq> <tag>
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Config;
use Orm\Orm;

[, $dsn, $schema, $first, $second, $tag] = $argv;
$db = Orm::connect($dsn, new Config(schemaPath: $schema, aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key'));
$runs = 0;
$db->transaction(function () use (&$runs, $first, $second, $tag): void {
    $runs++;
    (new Battle)->getBySeq((int) $first)->setName("deadlock-$tag")->update();
    if ($runs === 1) {
        fwrite(STDOUT, "locked\n");
        fgets(STDIN);
    }
    (new Battle)->getBySeq((int) $second)->setName("deadlock-$tag")->update();
});
fwrite(STDOUT, "done $runs\n");
