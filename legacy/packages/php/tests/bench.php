<?php

declare(strict_types=1);

// The install of the bench set for the tests: the bench set (contracts/fixtures/bench/dbspec-set.json) uses the table
// shared_note of its external document bench_shared.dbs, which must exist before the set installs (docs/spec/dbspec.md
// "External documents"), so the external document is installed first as its own set, as scripts/bench-db.mts does.

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Db;
use Polyspec\Orm\Dbspec\Dbspec;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\Code;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Schema;

/** The schema value of bench_shared.dbs, as the set that owns it would generate it. */
function benchShared(): Schema
{
    $manifest = Dbspec::manifest(
        RuntimeModel::files([dirname(__DIR__, 3) . '/contracts/fixtures/bench/bench_shared.dbs'])
    )->manifest
        ?? throw new OrmException(Code::SCHEMA_INVALID, 'contracts/fixtures/bench/bench_shared.dbs does not parse');
    return new Schema($manifest->manifestText, $manifest->manifestHash);
}

/** Installs the external document of the bench set, then the bench set, on the database of $db. */
function installBench(Db $db): void
{
    $db->utils()->schema()->install(benchShared());
    $db->utils()->schema()->install(Model\schema());
}
