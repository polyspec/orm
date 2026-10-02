<?php
// Engine test: manifest hash check, request validation, and statement forms of
// each dialect for the runtime model of schema/bench.dbs.
// Usage: php clients/php/tests/engine_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';

use Orm\Code;
use Orm\Engine;
use Orm\OrmException;
use Orm\RuntimeModel;

$root = dirname(__DIR__, 3);
$model = RuntimeModel::build(RuntimeModel::files(["$root/schema/bench.dbs"]));
$failures = 0;

function expect(bool $ok, string $message): void
{
    global $failures;
    if (!$ok) {
        $failures++;
        fwrite(STDERR, "FAIL $message\n");
    }
}

function code(callable $fn): string
{
    try {
        $fn();
    } catch (OrmException $e) {
        return $e->code_;
    }
    return 'no error';
}

$engines = [];
foreach (['mysql', 'postgres', 'sqlite'] as $d) {
    $engines[$d] = new Engine($model, $d, 8);
}
$request = static fn(array $ir): array => ['ir_version' => 1, 'manifest_hash' => $model->manifestHash] + $ir;
$byId = $request(['kind' => 'one', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 0]]]], 'n_params' => 1]);

$want = [
    'mysql' => 'SELECT `a`.`seq` AS `a__seq`, `a`.`name` AS `a__name` FROM `service` AS `a` WHERE `a`.`seq` = ? LIMIT 0, 1',
    'postgres' => 'SELECT "a"."seq" AS "a__seq", "a"."name" AS "a__name" FROM "service" AS "a" WHERE "a"."seq" = $1 LIMIT 1 OFFSET 0',
    'sqlite' => 'SELECT "a"."seq" AS "a__seq", "a"."name" AS "a__name" FROM "service" AS "a" WHERE "a"."seq" = ? LIMIT 1 OFFSET 0',
];
foreach ($engines as $d => $engine) {
    $plan = $engine->plan($byId);
    expect($plan['steps'][0]['sql'] === $want[$d], "$d primary-key select: {$plan['steps'][0]['sql']}");
    expect($engine->plan($byId) === $plan, "$d plan cache");
}

$mysql = $engines['mysql'];
foreach ([
    'unknown field' => [$request(['kind' => 'all', 'entity' => 'service', 'keyset' => ['direction' => 'after'], 'n_params' => 0]), Code::IR_INVALID],
    'raw kind' => [$request(['kind' => 'raw', 'entity' => 'service', 'n_params' => 0]), Code::IR_INVALID],
    'max kind' => [$request(['kind' => 'max', 'entity' => 'service', 'agg' => 'seq', 'n_params' => 0]), Code::IR_INVALID],
    'wrong type' => [$request(['kind' => 'all', 'entity' => 'service', 'n_params' => '0']), Code::IR_INVALID],
    'manifest hash' => [['ir_version' => 1, 'manifest_hash' => 'x', 'kind' => 'all', 'entity' => 'service', 'n_params' => 0], Code::SCHEMA_HASH_MISMATCH],
    'entity' => [$request(['kind' => 'all', 'entity' => 'missing', 'n_params' => 0]), Code::ENTITY_UNKNOWN],
    'param range' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 1]]]], 'n_params' => 1]), Code::IR_INVALID],
    'or first' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['conn' => 'or', 'column' => 'seq', 'op' => 'eq', 'p' => 0]]]], 'n_params' => 1]), Code::OR_AT_GROUP_START],
    'like op' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'name', 'op' => 'like', 'p' => 0]]]], 'n_params' => 1]), Code::OPERATOR_NOT_ALLOWED],
    'empty in' => [$request(['kind' => 'all', 'entity' => 'service', 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'in', 'ps' => []]]]], 'n_params' => 0]), Code::EMPTY_IN],
    'relation by name' => [$request(['kind' => 'all', 'entity' => 'service_member', 'relations' => [['rel' => 'service', 'query' => ['entity' => 'service']]], 'n_params' => 0]), Code::IR_INVALID],
    'join by name' => [$request(['kind' => 'all', 'entity' => 'service_member', 'joins' => [['rel' => 'service', 'kind' => 'inner', 'query' => ['entity' => 'service']]], 'n_params' => 0]), Code::IR_INVALID],
    'match op' => [$request(['kind' => 'all', 'entity' => 'author', 'where' => ['items' => [['pred' => ['op' => 'match', 'match' => ['name'], 'p' => 0]]]], 'n_params' => 1]), Code::IR_INVALID],
    'insert without required column' => [$request(['kind' => 'insert', 'entity' => 'service_region', 'set' => [['column' => 'name', 'p' => 0]], 'n_params' => 1]), Code::IR_INVALID],
    'update without where' => [$request(['kind' => 'update', 'entity' => 'service', 'set' => [['column' => 'name', 'p' => 0]], 'n_params' => 1]), Code::IR_INVALID],
] as $name => [$ir, $code]) {
    expect(code(fn() => $mysql->compile($ir)) === $code, "validation: $name");
}

// insert 는 identity column 값을, update 와 duplicate update 는 primary key 와
// identity column 값을 쓰지 못한다. PostgreSQL identity 는 명시한 key 를 지나
// 나아가지 않으므로(postgres.identity.by_default_not_advanced) 세 dialect 모두 거부한다.
$keyWrites = [
    'cannot set identity column seq' => $request(['kind' => 'insert', 'entity' => 'service', 'set' => [['column' => 'seq', 'p' => 0], ['column' => 'name', 'p' => 1]], 'n_params' => 2]),
    'cannot update seq' => $request(['kind' => 'update', 'entity' => 'service', 'set' => [['column' => 'seq', 'p' => 0]], 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 1]]]], 'n_params' => 2]),
    'on_duplicate cannot assign service.seq' => $request(['kind' => 'insert', 'entity' => 'service', 'set' => [['column' => 'name', 'p' => 0]], 'on_duplicate' => [['column' => 'seq', 'p' => 1]], 'n_params' => 2]),
    'on_duplicate cannot assign composite_account.tenant_id' => $request(['kind' => 'insert', 'entity' => 'composite_account', 'set' => [['column' => 'tenant_id', 'p' => 0], ['column' => 'account_id', 'p' => 1], ['column' => 'name', 'p' => 2]], 'on_duplicate' => [['column' => 'tenant_id', 'p' => 3]], 'n_params' => 4]),
];
foreach ($engines as $d => $engine) {
    foreach ($keyWrites as $message => $ir) {
        try {
            $engine->compile($ir);
            expect(false, "$d key write: $message: no error");
        } catch (OrmException $e) {
            expect($e->code_ === Code::IR_INVALID && str_contains($e->getMessage(), $message), "$d key write: want $message, got {$e->code_} {$e->getMessage()}");
        }
    }
}

// relation 은 foreign key 의 모든 성분을 key 순서대로 잇고, 잘못된 key 목록은 거절된다.
$compositeRelation = static fn(array $keys): array => $request(['kind' => 'all', 'entity' => 'composite_account', 'n_params' => 0,
    'relations' => [['rel' => 'memberships', 'kind' => 'many', 'keys' => $keys, 'query' => ['entity' => 'composite_membership']]]]);
$plan = $mysql->plan($compositeRelation([['left' => 'tenant_id', 'right' => 'tenant_id'], ['left' => 'account_id', 'right' => 'account_id']]));
expect(count($plan['steps']) === 2 && count($plan['steps'][1]['parent']['keys']) === 2, 'the composite relation step binds two parent keys');
expect(str_contains($plan['steps'][1]['sql'], 'WHERE (`a`.`tenant_id`, `a`.`account_id`) IN ((?))'), "composite relation SQL: {$plan['steps'][1]['sql']}");
$child = $plan['steps'][0]['assemble']['children'][0];
expect(array_column($child['parent_keys'], 'column') === ['tenant_id', 'account_id'] && array_column($child['child_keys'], 'column') === ['tenant_id', 'account_id'], 'composite relation keys in key order');
foreach ([
    [[], Code::IR_INVALID],
    [[['left' => 'tenant_id', 'right' => 'tenant_id'], ['left' => 'tenant_id', 'right' => 'account_id']], Code::IR_INVALID],
    [[['left' => 'tenant_id', 'right' => 'tenant_id'], ['left' => 'account_id', 'right' => 'tenant_id']], Code::IR_INVALID],
    [[['left' => 'tenant_id', 'right' => '']], Code::IR_INVALID],
    [[['left' => 'tenant_id', 'right' => 'tenant_id'], ['left' => 'nope', 'right' => 'account_id']], Code::COLUMN_UNKNOWN],
] as [$keys, $code]) {
    expect(code(fn() => $mysql->compile($compositeRelation($keys))) === $code, 'relation keys ' . json_encode($keys) . ": want $code");
}

$softRead = $request(['kind' => 'all', 'entity' => 'soft_record', 'n_params' => 0]);
$softDelete = $request(['kind' => 'delete', 'entity' => 'soft_record', 'n_params' => 1, 'where' => ['items' => [['pred' => ['column' => 'seq', 'op' => 'eq', 'p' => 0]]]]]);
foreach ($engines as $d => $engine) {
    $q = static fn(string $name): string => $d === 'mysql' ? "`$name`" : "\"$name\"";
    $read = $engine->plan($softRead)['steps'][0]['sql'];
    expect(str_contains($read, $q('a') . '.' . $q('deleted_at') . ' IS NULL'), "$d soft-delete read filter: $read");
    $delete = $engine->plan($softDelete)['steps'][0]['sql'];
    $mark = 'SET ' . $q('deleted_at') . ' = ' . ['mysql' => 'CURRENT_TIMESTAMP(6) ', 'postgres' => 'CURRENT_TIMESTAMP ', 'sqlite' => '? '][$d];
    expect(str_starts_with($delete, 'UPDATE ') && str_contains($delete, $mark) && str_contains($delete, $q('soft_record') . '.' . $q('deleted_at') . ' IS NULL'), "$d soft-delete guarded update: $delete");
}

if ($failures > 0) {
    fwrite(STDERR, "php engine test: $failures failures\n");
    exit(1);
}
echo "php engine test: passed\n";
