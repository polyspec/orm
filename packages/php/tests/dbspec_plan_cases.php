<?php

declare(strict_types=1);

// The one reader of tests/dbspec/plans.json for the PHP tests. DbspecPlanTest, DbspecPlanApplyTest, DbspecApplyTest and
// DbspecApplyCleanupTest all take their plans from here; the file is opened once per process.

/** The vectors of tests/dbspec/plans.json; every section must hold cases. */
function plan_vectors(): array
{
    static $vectors = null;
    if ($vectors !== null) {
        return $vectors;
    }
    $vectors = json_decode(file_get_contents(dirname(__DIR__, 3) . '/tests/dbspec/plans.json'), true, 512, JSON_THROW_ON_ERROR);
    if ($vectors['version'] !== 1 || ($vectors['cases'] ?? []) === [] || ($vectors['invalid'] ?? []) === [] || ($vectors['chains'] ?? []) === [] || ($vectors['parse'] ?? []) === [] || ($vectors['comparisons'] ?? []) === []) {
        throw new RuntimeException('tests/dbspec/plans.json has no version 1 cases, invalid cases, chains, parse cases and comparisons');
    }
    return $vectors;
}
