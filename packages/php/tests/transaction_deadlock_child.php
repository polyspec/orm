<?php

// One flow of the op transaction.deadlock of Recipe.php. Inside transaction(), at read_committed with a retry of 3: write the
// flow name to the first row, print "locked", wait for a line on stdin, then write it to the second row. The other flow runs
// with the rows swapped. The first line of stdin is the JSON of the schema of the case. Prints "done <callback runs> <1 when the first attempt ended with DEADLOCK, otherwise 0>".
// Usage: php transaction_deadlock_child.php <dsn> <tenant> <account> <other tenant> <other account> <name>
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Polyspec\Orm\Code;
use Polyspec\Orm\Config;
use Polyspec\Orm\Orm;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Schema;
use Polyspec\Orm\Tests\Model\CompositeAccount;

[, $dsn, $tenant, $account, $otherTenant, $otherAccount, $name] = $argv;
[$manifest, $hash, $external] = json_decode((string) fgets(STDIN), true, flags: JSON_THROW_ON_ERROR);
$db = Orm::connectSchema(
    $dsn,
    new Schema($manifest, $hash, $external),
    new Config(aesKey: 'bench-salt', blindIndexKey: 'bench-blind-index'),
);
$runs = 0;
$deadlocked = 0;
$db->transaction(
    function () use (&$runs, &$deadlocked, $db, $tenant, $account, $otherTenant, $otherAccount, $name): void {
        $runs++;
        (new CompositeAccount())($db)->getByTenantIdAndAccountId((int) $tenant, (int) $account)->setName($name)->update();
        if ($runs === 1) {
            fwrite(STDOUT, "locked\n");
            fgets(STDIN);
        }
        try {
            (new CompositeAccount())($db)
                ->getByTenantIdAndAccountId((int) $otherTenant, (int) $otherAccount)
                ->setName($name)
                ->update();
        } catch (OrmException $error) {
            if ($runs === 1 && $error->code_ === Code::DEADLOCK) {
                $deadlocked = 1;
            }
            throw $error;
        }
    },
    isolation: 'read_committed',
    retry: 3,
);
fwrite(STDOUT, "done $runs $deadlocked\n");
