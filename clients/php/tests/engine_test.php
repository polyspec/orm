<?php
// Engine test: manifest hash check, request validation, and statement forms of
// each dialect for the runtime model of schema/bench.dbs.
// Usage: php clients/php/tests/engine_test.php
declare(strict_types=1);

require __DIR__ . '/autoload.php';
require_once dirname(__DIR__, 3) . '/tests/testcase.php';

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

// engine check는 memory 안의 manifest 검사, request 검증, statement 형식을 한 case로 실행한다.
testcase_begin('engine', TESTCASE_COMPUTE);
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

// restore 는 primary key 나 unique key 하나의 eq 조건으로 soft delete column 을 NULL 로
// 되돌리는 update 하나다(engine/planner/restore_test.go 와 같은 case). 지워진 행만 고치고,
// audit table 이면 operation column 도 쓴다.
$restoreDocument = <<<'DBS'
dbspec 1 restore

table link {
  id i64 identity
  team_id i64
  member_id i64
  operation_id i64
  deleted_at datetime(6) null
  primary key (id)
  unique uq_link_pair (team_id, member_id)
  settings {
    soft_delete deleted_at
    audit into link_history operation operation_id action change previous previous_operation_id
  }
}

table link_history {
  history_id i64 identity
  change varchar(8)
  previous_operation_id i64 null
  id i64
  team_id i64
  member_id i64
  operation_id i64
  deleted_at datetime(6) null
  primary key (history_id)
}

table tag {
  id i64 identity
  name varchar(64)
  label varchar(64)
  deleted_at datetime(6) null
  primary key (id)
  unique uq_tag_name (name)
  settings {
    soft_delete deleted_at
  }
}

table plain {
  id i64 identity
  name varchar(64)
  primary key (id)
}

DBS;
$restoreModel = RuntimeModel::build(RuntimeModel::parse(['restore.dbs' => $restoreDocument]));
$restoreRequest = static function (string $entity, array ...$preds) use ($restoreModel): array {
    $items = [];
    $n = 0;
    foreach ($preds as $pred) {
        if (!isset($pred['p']) && $pred['op'] !== 'is_null') {
            $pred['p'] = $n++;
        }
        $items[] = ['pred' => $pred];
    }
    return ['ir_version' => 1, 'manifest_hash' => $restoreModel->manifestHash, 'kind' => 'restore', 'entity' => $entity, 'where' => ['items' => $items], 'n_params' => $n];
};
// withSet는 request의 set에 assignment를 더한다. 각 값은 where 다음 parameter다.
$withSet = static function (array $r, string ...$columns): array {
    foreach ($columns as $column) {
        $r['set'][] = ['column' => $column, 'p' => $r['n_params']++];
    }
    return $r;
};
$slotNames = static fn(array $slots): array => array_map(static fn(array $s): string => $s['from'] === 'param' ? "param {$s['param']}" : $s['from'], $slots);
foreach ([
    'unique key with audit' => ['sqlite', $restoreRequest('link', ['column' => 'team_id', 'op' => 'eq'], ['conn' => 'and', 'column' => 'member_id', 'op' => 'eq']),
        'UPDATE "link" SET "deleted_at" = NULL, "operation_id" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL',
        ['operation', 'param 0', 'param 1']],
    'unique key in another order' => ['mysql', $restoreRequest('link', ['column' => 'member_id', 'op' => 'eq'], ['conn' => 'and', 'column' => 'team_id', 'op' => 'eq']),
        'UPDATE `link` SET `deleted_at` = NULL, `operation_id` = ? WHERE `link`.`member_id` = ? AND `link`.`team_id` = ? AND `link`.`deleted_at` IS NOT NULL',
        ['operation', 'param 0', 'param 1']],
    'primary key' => ['postgres', $restoreRequest('link', ['column' => 'id', 'op' => 'eq']),
        'UPDATE "link" SET "deleted_at" = NULL, "operation_id" = $1 WHERE "link"."id" = $2 AND "link"."deleted_at" IS NOT NULL',
        ['operation', 'param 0']],
    'without audit' => ['mysql', $restoreRequest('tag', ['column' => 'name', 'op' => 'eq']),
        'UPDATE `tag` SET `deleted_at` = NULL WHERE `tag`.`name` = ? AND `tag`.`deleted_at` IS NOT NULL',
        ['param 0']],
    'new values' => ['sqlite', $withSet($restoreRequest('link', ['column' => 'team_id', 'op' => 'eq'], ['conn' => 'and', 'column' => 'member_id', 'op' => 'eq']), 'team_id'),
        'UPDATE "link" SET "team_id" = ?, "deleted_at" = NULL, "operation_id" = ? WHERE "link"."team_id" = ? AND "link"."member_id" = ? AND "link"."deleted_at" IS NOT NULL',
        ['param 2', 'operation', 'param 0', 'param 1']],
    'new value and null' => ['postgres', $withSet($restoreRequest('tag', ['column' => 'name', 'op' => 'eq']), 'label'),
        'UPDATE "tag" SET "label" = $1, "deleted_at" = NULL WHERE "tag"."name" = $2 AND "tag"."deleted_at" IS NOT NULL',
        ['param 1', 'param 0']],
] as $name => [$d, $ir, $sql, $slots]) {
    try {
        $plan = (new Engine($restoreModel, $d, 8))->compile($ir);
        expect(count($plan['steps']) === 1 && $plan['steps'][0]['role'] === 'main' && $plan['steps'][0]['sql'] === $sql, "restore $name: " . json_encode($plan['steps']) . " want $sql");
        expect($slotNames($plan['steps'][0]['bind_slots']) === $slots, "restore $name bind slots: " . json_encode($slotNames($plan['steps'][0]['bind_slots'])));
    } catch (OrmException $e) {
        expect(false, "restore $name: {$e->code_} {$e->getMessage()}");
    }
}
$restoreEngine = new Engine($restoreModel, 'sqlite', 8);
foreach ([
    'part of a unique key' => $restoreRequest('link', ['column' => 'team_id', 'op' => 'eq']),
    'a column that is no key' => $restoreRequest('tag', ['column' => 'label', 'op' => 'eq']),
    'a key and another column' => $restoreRequest('tag', ['column' => 'name', 'op' => 'eq'], ['conn' => 'and', 'column' => 'label', 'op' => 'eq']),
    'a repeated column' => $restoreRequest('tag', ['column' => 'name', 'op' => 'eq'], ['conn' => 'and', 'column' => 'name', 'op' => 'eq']),
    'another operator' => $restoreRequest('tag', ['column' => 'name', 'op' => 'gt']),
    'an or connector' => $restoreRequest('link', ['column' => 'team_id', 'op' => 'eq'], ['conn' => 'or', 'column' => 'member_id', 'op' => 'eq']),
    'a null test' => $restoreRequest('tag', ['column' => 'name', 'op' => 'is_null']),
    'no condition' => $restoreRequest('tag'),
    'a group' => ['where' => ['items' => [['group' => ['items' => [['pred' => ['column' => 'name', 'op' => 'eq', 'p' => 0]]]]]]], 'n_params' => 1] + $restoreRequest('tag'),
    'an assignment of the soft delete column' => $withSet($restoreRequest('tag', ['column' => 'name', 'op' => 'eq']), 'deleted_at'),
    'an assignment of the primary key' => $withSet($restoreRequest('tag', ['column' => 'name', 'op' => 'eq']), 'id'),
    'an assignment of the operation column' => $withSet($restoreRequest('link', ['column' => 'id', 'op' => 'eq']), 'operation_id'),
    'an optimistic check' => ['optimistic' => ['column' => 'label', 'p' => 0]] + $restoreRequest('tag', ['column' => 'name', 'op' => 'eq']),
    'a table without soft_delete' => $restoreRequest('plain', ['column' => 'id', 'op' => 'eq']),
] as $name => $ir) {
    expect(code(fn() => $restoreEngine->compile($ir)) === Code::IR_INVALID, "restore rejects $name: " . code(fn() => $restoreEngine->compile($ir)));
}

if ($failures > 0) {
    throw new RuntimeException("$failures check(s) failed; each FAIL line above names one");
}
testcase_end();
