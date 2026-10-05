<?php

declare(strict_types=1);

// 모든 공유 case, stress 문서, statement vector, plan vector, Mermaid vector의 PHP dbspec
// 결과를 tests/dbspec/compare/check.mjs의 줄 형식으로 출력한다.
//
// Usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>

require __DIR__ . '/../../../clients/php/vendor/autoload.php';
require __DIR__ . '/php-interface.php';

if ($argc !== 6) {
    fwrite(STDERR, "usage: php tests/dbspec/compare/php.php <cases.json> <stress document> <ddl.json> <plans.json> <mermaid.json>\n");
    exit(2);
}

dbspec_write_interface(Orm\Dbspec\Dbspec::class, $argv[1], $argv[2], $argv[3]);

/** step 하나를 statement 줄과 그 속성 줄로 쓴다(tests/dbspec/compare/check.mjs). */
function dbspec_step(Orm\Dbspec\PlanStep $s): void
{
    echo "| {$s->statement}\n";
    if ($s->finalize) {
        echo "  finalize\n";
    } elseif ($s->rollback !== '') {
        echo "  rollback: {$s->rollback}\n";
    } else {
        echo "  irreversible: {$s->irreversible}\n";
    }
    echo '  effect: ' . $s->effect->text() . "\n";
    if ($s->restore !== '') {
        echo "  restore: {$s->restore}\n";
    }
    if ($s->rollbackRestore !== '') {
        echo "  rollback_restore: {$s->rollbackRestore}\n";
    }
    if ($s->restore !== '' || $s->rollbackRestore !== '') {
        echo '  restore_if: ' . $s->restoreIf?->text() . "\n";
    }
    foreach ($s->nullChecks as $c) {
        echo "  null_check: {$c->table} {$c->column} " . ($c->default ?? 'none') . "\n";
    }
}

/**
  * diagnostic을 출력한다. plan, chain, compare diagnostic은 모든 client가 공유하는
  * message로 끝나고, target이나 source의 schema diagnostic은 그렇지 않다.
 *
 * @param list<Orm\Dbspec\Diagnostic> $diagnostics
 */
function dbspec_plan_diagnostics(array $diagnostics): void
{
    foreach ($diagnostics as $d) {
        echo in_array($d->rule, ['plan', 'chain', 'compare'], true) ? "! {$d->rule} {$d->line} {$d->column} {$d->message}\n" : "! {$d->rule} {$d->line} {$d->column}\n";
    }
}

/**
  * plan case의 source schema이고, 빈 schema이면 null, diagnostic을 출력했으면 false다.
 *
 * @param ?list<string> $lines
 */
function dbspec_plan_source(?array $lines): Orm\Dbspec\Document|null|false
{
    if ($lines === null) {
        return null;
    }
    $result = Orm\Dbspec\Dbspec::parse(dbspec_join($lines, false, false), []);
    if ($result->document === null) {
        dbspec_plan_diagnostics($result->diagnostics);
        return false;
    }
    return $result->document;
}

/** change를 "| kind table name"으로 출력한다. @param list<Orm\Dbspec\Change> $changes */
function dbspec_changes(array $changes): void
{
    foreach ($changes as $c) {
        echo "| {$c->kind} {$c->table} {$c->name}\n";
    }
}

/** emit한 plan의 줄을 출력한다. */
function dbspec_emitted_plan(Orm\Dbspec\Plan $plan): void
{
    foreach (explode("\n", Orm\Dbspec\Dbspec::emitPlan($plan)) as $line) {
        echo "| $line\n";
    }
}

$plans = dbspec_read_vectors($argv[4], static function (string $path, stdClass $v): array {
    $plans = [];
    foreach (['cases', 'invalid'] as $kind) {
        $plans[$kind] = dbspec_vector_cases($path, $v, $kind, static function (stdClass $case, string $at) use ($path): array {
            $source = dbspec_vector_field($path, $case, $at, 'source');
            return [
                'source' => $source === null ? null : dbspec_vector_check_lines($path, $source, "$at.source"),
                'plan' => dbspec_vector_lines($path, $case, $at, 'plan'),
            ];
        });
    }
    $plans['chains'] = dbspec_vector_cases($path, $v, 'chains', static function (stdClass $case, string $at) use ($path): array {
        $list = dbspec_vector_field($path, $case, $at, 'plans');
        if (!is_array($list)) {
            dbspec_vector_fail($path, "$at.plans", 'is not an array');
        }
        $chain = [];
        foreach ($list as $i => $lines) {
            $chain[] = dbspec_vector_check_lines($path, $lines, "$at.plans[$i]");
        }
        return ['plans' => $chain];
    });
    $plans['parse'] = dbspec_vector_cases($path, $v, 'parse', static fn(stdClass $case, string $at): array => [
        'plan' => dbspec_vector_lines($path, $case, $at, 'plan'),
    ]);
    $plans['comparisons'] = dbspec_vector_cases($path, $v, 'comparisons', static fn(stdClass $case, string $at): array => [
        'source' => dbspec_vector_lines($path, $case, $at, 'source'),
        'target' => dbspec_vector_lines($path, $case, $at, 'target'),
    ]);
    return $plans;
});
foreach ($plans['cases'] as $case) {
    echo "plans/cases/{$case['id']}\n";
    $source = dbspec_plan_source($case['source']);
    if ($source === false) {
        continue;
    }
    $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($case['plan'], false, false));
    if ($parsed->plan === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    dbspec_emitted_plan($parsed->plan);
    echo "plans/cases/{$case['id']}/changes\n";
    $diff = Orm\Dbspec\Dbspec::diff($source, $parsed->plan);
    dbspec_plan_diagnostics($diff->diagnostics);
    dbspec_changes($diff->changes ?? []);
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        echo "plans/cases/{$case['id']}/$dialect\n";
        $result = Orm\Dbspec\Dbspec::planSteps($source, $parsed->plan, $dialect);
        dbspec_plan_diagnostics($result->diagnostics);
        foreach ($result->steps ?? [] as $step) {
            dbspec_step($step);
        }
    }
}
foreach ($plans['invalid'] as $case) {
    echo "plans/invalid/{$case['id']}\n";
    $source = dbspec_plan_source($case['source']);
    if ($source === false) {
        continue;
    }
    $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($case['plan'], false, false));
    if ($parsed->plan === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    $diff = Orm\Dbspec\Dbspec::diff($source, $parsed->plan);
    dbspec_plan_diagnostics($diff->diagnostics);
    dbspec_changes($diff->changes ?? []);
}
foreach ($plans['chains'] as $case) {
    echo "plans/chains/{$case['id']}\n";
    $parsedPlans = [];
    foreach ($case['plans'] as $lines) {
        $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($lines, false, false));
        dbspec_plan_diagnostics($parsed->diagnostics);
        $parsedPlans[] = $parsed->plan;
    }
    if (in_array(null, $parsedPlans, true)) {
        continue;
    }
    $chain = Orm\Dbspec\Dbspec::chain($parsedPlans);
    dbspec_plan_diagnostics($chain->diagnostics);
    foreach ($chain->plans ?? [] as $plan) {
        echo "| {$plan->name}\n";
    }
}
foreach ($plans['parse'] as $case) {
    echo "plans/parse/{$case['id']}\n";
    $parsed = Orm\Dbspec\Dbspec::parsePlan(dbspec_join($case['plan'], false, false));
    if ($parsed->plan === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    dbspec_emitted_plan($parsed->plan);
}
foreach ($plans['comparisons'] as $case) {
    echo "plans/comparisons/{$case['id']}\n";
    $source = Orm\Dbspec\Dbspec::parse(dbspec_join($case['source'], false, false), []);
    dbspec_plan_diagnostics($source->diagnostics);
    $target = Orm\Dbspec\Dbspec::parse(dbspec_join($case['target'], false, false), []);
    dbspec_plan_diagnostics($target->diagnostics);
    if ($source->document === null || $target->document === null) {
        continue;
    }
    $result = Orm\Dbspec\Dbspec::compareSchemas($source->document, $target->document);
    dbspec_plan_diagnostics($result->diagnostics);
    foreach ($result->differences ?? [] as $d) {
        echo "| {$d->kind} {$d->table} {$d->name}\n";
    }
}

/** export나 import가 뺀 것을 "= kind<TAB>table<TAB>name"으로 출력하며 이유는 비교하지 않는다. @param list<Orm\Dbspec\Unsupported> $dropped */
function dbspec_dropped(array $dropped): void
{
    foreach ($dropped as $u) {
        echo "= {$u->kind}\t{$u->table}\t{$u->name}\n";
    }
}

/** 문서의 Mermaid text와 빠진 객체를 출력하고 text를 돌려준다. */
function dbspec_export(Orm\Dbspec\Document $document): string
{
    $result = Orm\Dbspec\Dbspec::exportMermaid($document);
    foreach (explode("\n", $result->text) as $line) {
        echo "| $line\n";
    }
    dbspec_dropped($result->dropped);
    return $result->text;
}

/** import의 emit한 문서와 빠진 객체를, 또는 diagnostic을 출력한다. */
function dbspec_import(string $text): void
{
    $result = Orm\Dbspec\Dbspec::importMermaid($text, 'imported');
    if ($result->document === null) {
        dbspec_plan_diagnostics($result->diagnostics);
        return;
    }
    foreach (explode("\n", Orm\Dbspec\Dbspec::emit($result->document)) as $line) {
        echo "| $line\n";
    }
    dbspec_dropped($result->dropped);
}

$mermaid = dbspec_read_vectors($argv[5], static function (string $path, stdClass $v): array {
    $mermaid = [];
    $mermaid['export'] = dbspec_vector_cases($path, $v, 'export', static fn(stdClass $case, string $at): array => [
        'document' => dbspec_vector_lines($path, $case, $at, 'document'),
        'documents' => dbspec_vector_documents($path, $case, $at, 'documents'),
    ]);
    foreach (['import', 'invalid'] as $kind) {
        $mermaid[$kind] = dbspec_vector_cases($path, $v, $kind, static fn(stdClass $case, string $at): array => [
            'mermaid' => dbspec_vector_lines($path, $case, $at, 'mermaid'),
        ]);
    }
    $mermaid['round_trip'] = dbspec_vector_cases($path, $v, 'round_trip', static fn(stdClass $case, string $at): array => [
        'path' => dbspec_vector_string($path, $case, $at, 'path'),
    ]);
    return $mermaid;
});
foreach ($mermaid['export'] as $case) {
    echo "mermaid/export/{$case['id']}\n";
    $set = array_map(static fn(array $lines): string => dbspec_join($lines, false, false), $case['documents']);
    $parsed = Orm\Dbspec\Dbspec::parse(dbspec_join($case['document'], false, false), $set);
    if ($parsed->document === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    dbspec_export($parsed->document);
}
foreach (['import', 'invalid'] as $kind) {
    foreach ($mermaid[$kind] as $case) {
        echo "mermaid/$kind/{$case['id']}\n";
        dbspec_import(dbspec_join($case['mermaid'], false, false));
    }
}
foreach ($mermaid['round_trip'] as $case) {
    echo "mermaid/round_trip/{$case['id']}\n";
    try {
        $read = Orm\Dbspec\Dbspec::readFile($case['path']);
    } catch (RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }
    if ($read->text === null) {
        dbspec_plan_diagnostics($read->diagnostics);
        continue;
    }
    $parsed = Orm\Dbspec\Dbspec::parse($read->text, []);
    if ($parsed->document === null) {
        dbspec_plan_diagnostics($parsed->diagnostics);
        continue;
    }
    $text = dbspec_export($parsed->document);
    echo "mermaid/round_trip/{$case['id']}/import\n";
    dbspec_import($text);
}
