<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;

/**
 * The grouped counts of the bench authors on each database, shared by the PHP library and the extension: a class that
 * uses it also uses DatabaseTestAssertions.
 */
trait GroupRowsDbCases
{
    // Requirements: INT-31.
    public function testGroupRows(): void
    {
        $this->forEachBenchDatabase(static function (Db $db): void {
            GroupRowsDbCase::run($db);
        });
    }
}
