<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;

/** Runs the grouped-row assertion helper once for each benchmark database. */
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
