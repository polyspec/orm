<?php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Compiler\V1\Assemble;
use Orm\Compiler\V1\BindSlot;
use Orm\Compiler\V1\OutputColumn;
use Orm\Compiler\V1\Plan;
use Orm\Compiler\V1\PlanStep;
use Orm\Compiler\V1\QueryKind;
use Orm\CompilerBridge;

$request = CompilerBridge::request([
    'ir_version' => 1, 'schema_hash' => 'schema', 'kind' => 'update', 'n_params' => 3,
    'entity' => 'battle', 'scope_p' => 0,
    'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 1]]]],
    'joins' => [['rel' => 'service', 'kind' => 'left', 'query' => ['entity' => 'service']]],
    'set' => [['column' => 'name', 'p' => 2]],
]);
if ($request->getParameterCount() !== 3 || !$request->getRoot()->hasScopeParameter()
    || $request->getRoot()->getScopeParameter() !== 0 || $request->getRoot()->getJoins()[0]->getQuery()->getEntity() !== 'service'
    || $request->getSet()[0]->getParameter() !== 2) {
    throw new RuntimeException('request conversion failed');
}

$plan = CompilerBridge::plan(new Plan([
    'schema_hash' => 'schema', 'kind' => QueryKind::QUERY_KIND_ALL,
    'steps' => [new PlanStep([
        'id' => 0, 'role' => 'root', 'sql' => 'SELECT ?',
        'binds' => [new BindSlot(['source' => 'param', 'parameter' => 1, 'host_styles' => ['hex'], 'column_type' => 'string'])],
        'assemble' => new Assemble(['entity' => 'battle', 'alias' => 'a', 'columns' => [new OutputColumn(['index' => 0, 'name' => 'seq', 'column' => 'seq', 'type' => 'i64'])]]),
    ])],
]));
if ($plan['kind'] !== 'all' || $plan['steps'][0]['bind_slots'][0]['param'] !== 1
    || $plan['steps'][0]['bind_slots'][0]['host_styles'] !== ['hex'] || $plan['steps'][0]['assemble']['columns'][0]['type'] !== 'i64') {
    throw new RuntimeException('plan conversion failed');
}

try {
    CompilerBridge::request(['ir_version' => 1, 'kind' => 'all', 'entity' => 'battle', 'n_params' => -1]);
    throw new RuntimeException('invalid integer was accepted');
} catch (\Orm\OrmException $error) {
    if ($error->code_ !== \Orm\Code::IR_INVALID) throw $error;
}

echo "php compiler bridge: request, plan, and invalid input passed\n";
