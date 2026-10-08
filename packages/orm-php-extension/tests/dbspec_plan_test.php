<?php
declare(strict_types=1);
// The plan vectors of tests/dbspec/plans.json through the PHP extension
// orm_dbspec (Polyspec\Orm\Dbspec\Native\Dbspec), the same cases as the PHP client's
// packages/orm-php/tests/dbspec_plan_test.php: every case's canonical emission,
// changes and steps of three dialects, every invalid case's `plan`
// diagnostics, every chain case's order or `chain` diagnostics, every parse
// case's diagnostics with rule, line, column and the message of a `plan`
// diagnostic, every comparison's differences or `compare` diagnostics, and
// the unknown dialect rule.
// Usage: php -d extension=<orm_dbspec library> packages/orm-php-extension/tests/dbspec_plan_test.php
require_once dirname(__DIR__, 3) . '/packages/orm-php/tests/case_clock.php';

if (!extension_loaded('orm_dbspec')) {
    fwrite(STDERR, "the extension orm_dbspec is not loaded; run make dbspec-php-extension-check, which builds and loads it\n");
    exit(1);
}

use Polyspec\Orm\Dbspec\Native\Change;
use Polyspec\Orm\Dbspec\Native\Dbspec;
use Polyspec\Orm\Dbspec\Native\Diagnostic;
use Polyspec\Orm\Dbspec\Native\Difference;
use Polyspec\Orm\Dbspec\Native\Document;
use Polyspec\Orm\Dbspec\Native\Plan;
use Polyspec\Orm\Dbspec\Native\PlanStep;

const CASE_DEADLINE_MS = 5000;

/**
 * step 의 plans.json object 다(docs/plans.md "Steps"). key 는 이름 순이다.
 *
 * @return array<string, mixed>
 */
function step_fields(PlanStep $s): array
{
    $out = ['statement' => $s->statement, 'effect' => $s->effect->text()];
    if ($s->rollback !== '') {
        $out['rollback'] = $s->rollback;
    } elseif ($s->irreversible !== '') {
        $out['irreversible'] = $s->irreversible;
    }
    if ($s->restore !== '') {
        $out['restore'] = $s->restore;
    }
    if ($s->rollbackRestore !== '') {
        $out['rollback_restore'] = $s->rollbackRestore;
    }
    if ($s->restore !== '' || $s->rollbackRestore !== '') {
        $out['restore_if'] = $s->restoreIf?->text();
    }
    if ($s->nullChecks !== []) {
        $out['null_checks'] = array_map(static fn($c): array => [$c->table, $c->column, $c->default], $s->nullChecks);
    }
    if ($s->finalize) {
        $out['finalize'] = true;
    }
    ksort($out);
    return $out;
}

$root = dirname(__DIR__, 3);
$vectors = json_decode(file_get_contents("$root/tests/dbspec/plans.json"), true, 512, JSON_THROW_ON_ERROR);
if ($vectors['version'] !== 1 || ($vectors['cases'] ?? []) === [] || ($vectors['invalid'] ?? []) === [] || ($vectors['chains'] ?? []) === [] || ($vectors['parse'] ?? []) === [] || ($vectors['comparisons'] ?? []) === []) {
    throw new RuntimeException('tests/dbspec/plans.json has no version 1 cases, invalid cases, chains, parse cases and comparisons');
}

/** @param list<string> $lines */
function plan_text(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @param list<Diagnostic> $diagnostics */
function plan_diagnostics(array $diagnostics): string
{
    return json_encode(array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message], $diagnostics));
}

/** @param ?list<string> $lines */
function plan_source(string $id, ?array $lines): ?Document
{
    if ($lines === null) {
        return null;
    }
    $result = Dbspec::parse(plan_text($lines), []);
    return $result->document ?? throw new RuntimeException("$id: source diagnostics " . plan_diagnostics($result->diagnostics));
}

function plan_of(string $id, array $lines): Plan
{
    $result = Dbspec::parsePlan(plan_text($lines));
    return $result->plan ?? throw new RuntimeException("$id: plan diagnostics " . plan_diagnostics($result->diagnostics));
}

/** @param list<Diagnostic> $diagnostics @return list<string> */
function plan_messages(string $id, string $rule, array $diagnostics): array
{
    $messages = [];
    foreach ($diagnostics as $d) {
        if ($d->rule !== $rule) {
            throw new RuntimeException("$id: rule {$d->rule}, want $rule");
        }
        $messages[] = $d->message;
    }
    return $messages;
}

function finish_plan_case(string $id, array $caseStarted): void
{
    cpuCaseEnd($id, $caseStarted);
}

foreach ($vectors['cases'] as $case) {
    $id = "plan/{$case['id']}";
    $caseStarted = cpuCaseBegin($id, CASE_DEADLINE_MS / 1000);
    $source = plan_source($id, $case['source'] ?? null);
    $plan = plan_of($id, $case['plan']);
    $emitted = Dbspec::emitPlan($plan);
    if ($emitted !== plan_text($case['plan'])) {
        throw new RuntimeException("$id: emitPlan differs\n--- want\n" . plan_text($case['plan']) . "--- got\n$emitted");
    }
    $diff = Dbspec::diff($source, $plan);
    $changes = $diff->changes ?? throw new RuntimeException("$id: diff diagnostics " . plan_diagnostics($diff->diagnostics));
    $got = array_map(static fn(Change $c): array => [$c->kind, $c->table, $c->name], $changes);
    if ($got !== $case['changes']) {
        throw new RuntimeException("$id: changes\nwant " . json_encode($case['changes']) . "\ngot  " . json_encode($got));
    }
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        $want = $case['steps'][$dialect] ?? throw new RuntimeException("$id: no $dialect steps");
        $result = Dbspec::planSteps($source, $plan, $dialect);
        $steps = $result->steps ?? throw new RuntimeException("$id/$dialect: diagnostics " . plan_diagnostics($result->diagnostics));
        for ($i = 0; $i < max(count($steps), count($want)); $i++) {
            $got = isset($steps[$i]) ? step_fields($steps[$i]) : null;
            $expected = $want[$i] ?? null;
            if ($expected !== null) {
                ksort($expected);
            }
            if ($got !== $expected) {
                throw new RuntimeException("$id/$dialect: step $i differs\n--- want\n" . json_encode($expected, JSON_UNESCAPED_SLASHES) . "\n--- got\n" . json_encode($got, JSON_UNESCAPED_SLASHES));
            }
        }
    }
    finish_plan_case($id, $caseStarted);
}

foreach ($vectors['invalid'] as $case) {
    $id = "plan/invalid/{$case['id']}";
    $caseStarted = cpuCaseBegin($id, CASE_DEADLINE_MS / 1000);
    $source = plan_source($id, $case['source'] ?? null);
    $parsed = Dbspec::parsePlan(plan_text($case['plan']));
    $diagnostics = $parsed->plan === null ? $parsed->diagnostics : Dbspec::diff($source, $parsed->plan)->diagnostics;
    $got = plan_messages($id, 'plan', $diagnostics);
    if ($got !== $case['errors']) {
        throw new RuntimeException("$id: errors\nwant " . json_encode($case['errors']) . "\ngot  " . json_encode($got));
    }
    // step 도 diff 와 같은 diagnostic 으로 거절한다.
    if ($parsed->plan !== null) {
        $steps = Dbspec::planSteps($source, $parsed->plan, 'postgres');
        if ($steps->steps !== null || plan_messages($id, 'plan', $steps->diagnostics) !== $case['errors']) {
            throw new RuntimeException("$id: planSteps does not report the diff diagnostics: " . plan_diagnostics($steps->diagnostics));
        }
    }
    finish_plan_case($id, $caseStarted);
}

foreach ($vectors['chains'] as $case) {
    $id = "plan/chain/{$case['id']}";
    $caseStarted = cpuCaseBegin($id, CASE_DEADLINE_MS / 1000);
    $plans = array_map(static fn(array $lines): Plan => plan_of($id, $lines), $case['plans']);
    $chain = Dbspec::chain($plans);
    $errors = plan_messages($id, 'chain', $chain->diagnostics);
    if ($errors !== ($case['errors'] ?? [])) {
        throw new RuntimeException("$id: errors\nwant " . json_encode($case['errors'] ?? []) . "\ngot  " . json_encode($errors));
    }
    $order = array_map(static fn(Plan $p): string => $p->name, $chain->plans ?? []);
    if ($order !== ($case['order'] ?? [])) {
        throw new RuntimeException("$id: order\nwant " . json_encode($case['order'] ?? []) . "\ngot  " . json_encode($order));
    }
    finish_plan_case($id, $caseStarted);
}

foreach ($vectors['parse'] as $case) {
    $id = "plan/parse/{$case['id']}";
    $caseStarted = cpuCaseBegin($id, CASE_DEADLINE_MS / 1000);
    $parsed = Dbspec::parsePlan(plan_text($case['plan']));
    // plan diagnostic 은 message 까지, target diagnostic 은 rule, 줄, 칸까지 비교한다.
    $got = array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->rule === 'plan' ? $d->message : null], $parsed->diagnostics);
    if ($got !== $case['errors']) {
        throw new RuntimeException("$id: errors\nwant " . json_encode($case['errors']) . "\ngot  " . json_encode($got));
    }
    finish_plan_case($id, $caseStarted);
}

foreach ($vectors['comparisons'] as $case) {
    $id = "plan/comparison/{$case['id']}";
    $caseStarted = cpuCaseBegin($id, CASE_DEADLINE_MS / 1000);
    $source = plan_source("$id/source", $case['source']);
    $target = plan_source("$id/target", $case['target']);
    $result = Dbspec::compareSchemas($source, $target);
    $got = array_map(static fn(Difference $d): array => [$d->kind, $d->table, $d->name], $result->differences ?? []);
    if ($got !== $case['differences']) {
        throw new RuntimeException("$id: differences\nwant " . json_encode($case['differences']) . "\ngot  " . json_encode($got));
    }
    $errors = array_map(static fn(Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message], $result->diagnostics);
    if ($errors !== $case['errors']) {
        throw new RuntimeException("$id: errors\nwant " . json_encode($case['errors']) . "\ngot  " . json_encode($errors));
    }
    finish_plan_case($id, $caseStarted);
}

testcase_begin('plan/unknown-dialect', TESTCASE_COMPUTE);
try {
    Dbspec::planSteps(null, plan_of('plan/unknown-dialect', $vectors['cases'][0]['plan']), 'oracle');
    throw new RuntimeException('unknown dialect oracle was accepted');
} catch (InvalidArgumentException $e) {
    if (!str_contains($e->getMessage(), 'oracle')) {
        throw new RuntimeException('unknown dialect message does not name it: ' . $e->getMessage());
    }
}
testcase_end();

