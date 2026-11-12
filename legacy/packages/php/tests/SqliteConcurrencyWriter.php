<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Tests\Model\Service;

/** The read-then-write transaction loop shared by the concurrency case and its child process. */
final class SqliteConcurrencyWriter
{
    public static function writeServices(Db $db, string $name, int $count): void
    {
        for ($i = 0; $i < $count; $i++) {
            $db->transaction(function () use ($name, $i): void {
                (new Service())->getCount();
                (new Service())->setName("$name-$i")->create();
            }, retry: 0);
        }
    }
}
