<?php
// One side of the deadlock gate in integration.php. Inside transaction(): UPDATE the first row,
// report "locked" on stdout, block on stdin for "go", then UPDATE the second row. The other side
// runs the same with the rows swapped, so MySQL reports 1213 to one of them and transaction()
// re-runs its closure. Prints "done <closure runs>" and exits 0.
// Usage: php deadlock_child.php /abs/ormd.sock /abs/schema.json <first_seq> <second_seq> <tag>
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Config;
use Orm\Db;
use Orm\Orm;
use Orm\Tx;

[, $sock, $schema, $first, $second, $tag] = $argv;
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt'));
$db = Db::mysql(orm_test_dsn(), 'root', '', persistent: false);

$runs = 0;
$db->transaction(function (Tx $tx) use (&$runs, $first, $second, $tag): void {
    $runs++;
    (new Battle)->seqEq((int) $first)->setName("dl-php-$tag")->update($tx);
    if ($runs === 1) {
        // Barrier: both sides hold their first row before either asks for its second.
        // The re-run after the deadlock must not wait again — the parent released us once.
        fwrite(STDOUT, "locked\n");
        fgets(STDIN);
    }
    (new Battle)->seqEq((int) $second)->setName("dl-php-$tag")->update($tx);
});
fwrite(STDOUT, "done $runs\n");
