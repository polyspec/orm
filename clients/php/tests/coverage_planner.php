<?php
declare(strict_types=1);
// planner feature coverage: contracts/fixtures/planner.json의 요청에
// schema/bench.dbs의 manifest hash를 더해 각 dialect의 PHP engine으로
// compile하고, statement의 role, sql, bind slot의 param 순서나 오류 code를
// fixture와 비교한다.

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/coverage_cases.php';

use Orm\Engine;
use Orm\OrmException;
use Orm\RuntimeModel;

$root = dirname(__DIR__, 3);
$fixture = coverageJson("$root/contracts/fixtures/planner.json");

/**
 * case의 요청을 각 dialect로 compile해 기대값과 비교한다.
 * bind slot은 param slot이면 그 번호로, 다른 slot이면 slot 전체로 비교한다.
 */
function plannerCase(string $root, array $fixture, string $id): void
{
    $found = array_values(array_filter($fixture['cases'], static fn(array $c): bool => $c['id'] === $id));
    coverageWant(count($found) === 1, "planner.json has " . count($found) . " cases $id");
    $case = $found[0];
    coverageWant($case['operation'] === 'compile', "case $id has operation {$case['operation']}");
    $model = RuntimeModel::build(RuntimeModel::files(["$root/schema/bench.dbs"]));
    $request = ['manifest_hash' => $model->manifestHash] + $case['input'];
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        $engine = new Engine($model, $dialect, 8);
        if (isset($case['expected']['error'])) {
            $code = coverageCode(fn() => $engine->compile($request));
            coverageWant($code === $case['expected']['error'], "$dialect $id is $code, want {$case['expected']['error']}");
            continue;
        }
        $plan = $engine->compile($request);
        $statements = array_map(static fn(array $step): array => [
            'params' => array_map(static fn(array $slot): mixed => ($slot['from'] ?? '') === 'param' ? $slot['param'] : $slot, $step['bind_slots']),
            'role' => $step['role'],
            'sql' => $step['sql'],
        ], $plan['steps']);
        coverageWant($statements === $case['expected'][$dialect], "$dialect $id statements " . json_encode($statements));
    }
}

runCoverageCases($argv, [
    'planner_statement' => fn() => plannerCase($root, $fixture, 'planner_statement'),
    'planner_count' => fn() => plannerCase($root, $fixture, 'planner_count'),
    'planner_rejects_unknown_column' => fn() => plannerCase($root, $fixture, 'planner_rejects_unknown_column'),
]);
