<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PDOException;
use RuntimeException;

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
