<?php

declare(strict_types=1);

/*
 * A test that needs more memory than the default 128M of the CLI states its budget: the memory it may use itself. The
 * process of a suite already holds what the tests before it left, so the budget counts above that, and a limit is never
 * lowered: a process without a limit (-1), as the runners of CI start it, keeps none, and a test never fails on what
 * another test left.
 */

/** Makes room for $budget (an ini quantity such as 512M) above what the process holds; $owner names the test. */
function requireMemoryBudget(string $budget, string $owner): void
{
    $current = (string) ini_get('memory_limit');
    if ($current === '-1') {
        return;
    }
    $wanted = memory_get_usage() + ini_parse_quantity($budget);
    if (ini_parse_quantity($current) >= $wanted) {
        return;
    }
    if (ini_set('memory_limit', (string) $wanted) === false) {
        throw new RuntimeException("$owner requires $budget of memory above what the process holds");
    }
}
