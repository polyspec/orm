<?php
// One side of the deadlock gate in integration.php. Inside transaction(): UPDATE the first row,
// report "locked" on stdout, block on stdin for "go", then UPDATE the second row. The other side
// runs the same with the rows swapped, so MySQL reports 1213 (PostgreSQL 40P01) to one of them and transaction()
// re-runs its closure. ORM_TEST_DRIVER / ORM_TEST_DSN select the database as in integration.php. Prints "done <closure runs>" and exits 0.
// Usage: php deadlock_child.php /abs/ormd.sock /abs/schema.json <first_seq> <second_seq> <tag>
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use App\Orm\Battle;
use Orm\Config;
use Orm\Orm;
use Orm\Tx;
use Orm\TransactionOptions;

[, $sock, $schema, $first, $second, $tag] = $argv;
Orm::init(new Config(socket: $sock, schemaPath: $schema, aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index', driver: orm_test_driver()));
$db = orm_open_db(orm_test_driver(), orm_test_dsn(), persistent: false);

$runs = 0;
$db->transaction(function (Tx $tx) use (&$runs, $first, $second, $tag): void {
    $runs++;
    Battle::query()->seqEq((int) $first)->setName("dl-php-$tag")->using($tx)->update();
    if ($runs === 1) {
        // Barrier: both sides hold their first row before either asks for its second.
        // The re-run after the deadlock must not wait again — the parent released us once.
        fwrite(STDOUT, "locked\n");
        fgets(STDIN);
    }
    Battle::query()->seqEq((int) $second)->setName("dl-php-$tag")->using($tx)->update();
}, new TransactionOptions(retryDeadlocks: true, maxAttempts: 3));
fwrite(STDOUT, "done $runs\n");
