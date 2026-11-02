<?php

declare(strict_types=1);

// The one reader of the plan cases for the PHP tests: tests/dbspec/plan-cases.json (a recipe) with the database data of
// each case in tests/dbspec/plans-physical.json, keyed by case id. DbspecPlanApplyTest, DbspecApplyTest and the apply
// and compare tools take their cases from here; the file is read once per process.

/**
 * The vectors of the plans.json at plansPath: its version, and its cases, which are the recipe plan-cases.json beside
 * it, each with its before and after records from plans-physical.json. The validation sections are recipes beside it
 * (plan-invalid, plan-chains, plan-parse and plan-comparisons .json), run by the recipe helper, so they are not read
 * here.
 *
 * @return array{version: int, cases: list<array<string, mixed>>}
 */
function plan_vectors_at(string $plansPath): array
{
    $dir = dirname($plansPath);
    $meta = json_decode(file_get_contents($plansPath), true, 512, JSON_THROW_ON_ERROR);
    $recipe = json_decode(file_get_contents($dir . '/plan-cases.json'), true, 512, JSON_THROW_ON_ERROR);
    $physical = json_decode(file_get_contents($dir . '/plans-physical.json'), true, 512, JSON_THROW_ON_ERROR)['cases'];
    if ($meta['version'] !== 1 || ($recipe['cases'] ?? []) === []) {
        throw new RuntimeException("$plansPath has no version 1 plan cases");
    }
    $cases = [];
    foreach ($recipe['cases'] as $rc) {
        $case = ['id' => $rc['id'], 'source' => null, 'plan' => [], 'changes' => [], 'steps' => []];
        foreach ($rc['steps'] as $step) {
            if ($step['op'] === 'dbspec.parse' && ($step['as'] ?? null) === 'source') {
                $case['source'] = $step['lines'];
            } elseif ($step['op'] === 'dbspec.parse_plan') {
                $case['plan'] = $step['lines'];
            } elseif ($step['op'] === 'dbspec.diff') {
                $case['changes'] = $step['expect']['none']['changes'];
            } elseif ($step['op'] === 'dbspec.plan_steps') {
                $case['steps'][$step['dialect']] = $step['expect']['none']['steps'];
            }
        }
        $record = $physical[$rc['id']] ?? throw new RuntimeException("{$rc['id']}: no physical record");
        $case['before'] = $record['before'];
        $case['after'] = $record['after'];
        $cases[] = $case;
    }
    return ['version' => 1, 'cases' => $cases];
}

/**
 * The vectors of tests/dbspec/plans.json (plan_vectors_at of the repository's file), read once per process.
 *
 * @return array{version: int, cases: list<array<string, mixed>>}
 */
function plan_vectors(): array
{
    static $vectors = null;
    return $vectors ??= plan_vectors_at(dirname(__DIR__, 3) . '/tests/dbspec/plans.json');
}

/** @param list<string> $lines */
function dbspec_plan_text(array $lines): string
{
    return implode("\n", $lines) . "\n";
}

/** @param list<\Polyspec\Orm\Dbspec\Diagnostic> $diagnostics */
function plan_diagnostics(array $diagnostics): string
{
    return json_encode(
        array_map(
            static fn(\Polyspec\Orm\Dbspec\Diagnostic $d): array => [$d->rule, $d->line, $d->column, $d->message],
            $diagnostics
        )
    );
}
