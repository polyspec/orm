<?php
// The request hook of the PHP client on SQLite: the shared cases of
// request_hook_cases.php, each on a SQLite file of its own under a temporary
// directory that the test removes on every path.
// Usage: php packages/orm-php/tests/request_hook_test.php [case ...]
declare(strict_types=1);

require __DIR__ . '/request_hook_cases.php';

$databases = 0;
$failed = 0;
$selected = array_slice($argv, 1) ?: array_keys(REQUEST_HOOK_CASES);
foreach ($selected as $case) {
    $databases++;
    $dsn = "sqlite://$work/case-$databases.sqlite";
    $passed = testcase_run("request-hook/$case", TESTCASE_DATABASE, static function (callable $step) use ($case, $dsn): void {
        runRequestHookCase($case, $dsn);
    });
    if (!$passed) {
        $failed++;
    }
}
if ($failed > 0) {
    exit(1);
}
