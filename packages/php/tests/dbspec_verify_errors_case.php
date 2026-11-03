<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;
use Polyspec\Orm\Dbspec\Dbspec;
use RuntimeException;

/** The create-from-empty plan of tests/dbspec/plan-cases.json. */
function verify_errors_plan(): array
{
    foreach (plan_vectors()['cases'] as $case) {
        if ($case['id'] === 'create-from-empty') {
            $parsed = Dbspec::parsePlan(implode("\n", $case['plan']) . "\n");
            return [$parsed->plan ?? throw new RuntimeException(
                'create-from-empty: ' . json_encode($parsed->diagnostics)
            )];
        }
    }
    throw new RuntimeException('plan-cases.json has no create-from-empty case');
}

/**
 * FailingPdo on a new SQLite file owned by $run.
 *
 * @param array<string, PDOException> $fail
 * @param array<string, string> $replace
 * @param list<string> $failClose
 * @param array<string, PDOException> $queryFail
 */
function dbspec_failing_pdo(
    string $run,
    array $fail,
    array $replace = [],
    array $failClose = [],
    array $queryFail = []
): FailingPdo {
    static $fileIndex = 0;
    $fileIndex++;
    $path = sys_get_temp_dir() . sprintf('/%s_%d_%02d.sqlite', $run, getmypid(), $fileIndex);
    if (file_exists($path)) {
        throw new RuntimeException("SQLite file $path already exists");
    }
    register_shutdown_function(static function () use ($path): void {
        foreach (['', '-journal'] as $suffix) {
            if (file_exists($path . $suffix) && !unlink($path . $suffix)) {
                throw new RuntimeException("$path$suffix cannot be removed");
            }
        }
    });
    return new FailingPdo($path, $fail, $replace, $failClose, $queryFail);
}
