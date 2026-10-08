<?php
// Statement events on SQLite, MySQL and PostgreSQL: every case of the shared
// vector tests/events/vectors.json in a case database of its own
// (statement_events_run.php), and the vector's server_transactions on
// PostgreSQL (case id server_transactions). The test fails when
// ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.
// Usage: php packages/orm-php/tests/statement_events_test.php [case ...]
declare(strict_types=1);

require __DIR__ . '/statement_events_run.php';

$cases = [];
foreach ($vector['cases'] as $case) {
    $cases[$case['id']] = $case;
}
$selected = array_slice($argv, 1) ?: [...array_keys($cases), 'server_transactions'];
foreach ($selected as $id) {
    if ($id === 'server_transactions') {
        $spec = $vector['server_transactions'];
        $before = $failures;
        $current = "$id/{$spec['database']}";
        $passed = testcase_run("statement_events/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($spec, $cases, $before): void {
            with_case_database($spec['database'], $step, static fn(string $dsn) => runServerTransactions($spec, $cases, $dsn));
            if ($GLOBALS['failures'] > $before) {
                throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
            }
        });
        if (!$passed && $failures === $before) {
            $failures++;
        }
        continue;
    }
    if (!isset($cases[$id])) {
        throw new RuntimeException("unknown case $id");
    }
    foreach (['sqlite', 'mysql', 'postgres'] as $driver) {
        $before = $failures;
        $current = "$id/$driver";
        $passed = testcase_run("statement_events/$current", CASE_DEADLINE_SECONDS, static function (callable $step) use ($cases, $id, $driver, $before): void {
            with_case_database($driver, $step, static fn(string $dsn) => runCase($cases[$id], $driver, $dsn));
            if ($GLOBALS['failures'] > $before) {
                throw new RuntimeException(($GLOBALS['failures'] - $before) . ' check(s) failed; each FAIL line above names one');
            }
        });
        if (!$passed && $failures === $before) {
            $failures++;
        }
    }
}
if ($failures > 0) {
    exit(1);
}
