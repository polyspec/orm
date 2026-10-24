<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use PHPUnit\Framework\Assert;

/** Runs the shared stress document generator and returns its source text. */
function dbspec_stress_document(): string
{
    $root = dirname(__DIR__, 3);
    $process = proc_open(
        ['node', "$root/tests/dbspec/stress.mts"],
        [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes
    );
    Assert::assertTrue(is_resource($process), 'node tests/dbspec/stress.mts did not start');
    $text = stream_get_contents($pipes[1]);
    $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_close($process);
    Assert::assertFalse(
        $status !== 0 || $text === false || $text === '',
        "node tests/dbspec/stress.mts failed with status $status: $errors"
    );
    return $text;
}
