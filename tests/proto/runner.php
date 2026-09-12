<?php
declare(strict_types=1);

require dirname(__DIR__, 2) . '/clients/php/vendor/autoload.php';

$endpoint = $argv[1] ?? throw new RuntimeException('endpoint required');
$compiler = new Orm\ConnectCompiler($endpoint);
$metadata = $compiler->metadata();
$predicate = new Orm\Compiler\V1\Predicate(['column' => 'service_seq', 'operator' => 'eq', 'parameter' => 1]);
$item = new Orm\Compiler\V1\Item(['predicate' => $predicate]);
$where = new Orm\Compiler\V1\Group(['items' => [$item]]);
$root = new Orm\Compiler\V1\QueryNode(['entity' => 'battle', 'scope_parameter' => 0, 'where' => $where]);
$request = new Orm\Compiler\V1\CompileRequest([
    'ir_version' => 1,
    'schema_hash' => $metadata->getSchemaHash(),
    'kind' => Orm\Compiler\V1\QueryKind::QUERY_KIND_COUNT,
    'parameter_count' => 2,
    'root' => $root,
]);
$plan = $compiler->compile($request);
$step = $plan->getSteps()[0];
echo json_encode([
    'schema_hash' => $metadata->getSchemaHash(),
    'dialect' => $metadata->getDialect(),
    'ir_version' => $metadata->getIrVersion(),
    'sql' => $step->getSql(),
    'bind_parameters' => array_map(static fn($bind) => $bind->getParameter(), iterator_to_array($step->getBinds())),
    'output_columns' => $step->hasAssemble() ? count($step->getAssemble()->getColumns()) : 0,
], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), "\n";
