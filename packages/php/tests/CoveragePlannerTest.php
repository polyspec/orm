<?php

declare(strict_types=1);

// planner feature coverage: the requests in contracts/fixtures/planner.json,
// with the manifest hash of that case's schema document added, are compiled by the PHP engine of each dialect,
// and the statement's role, sql, bind slots (source, param number, type), or error
// code are compared with the fixture.


use Polyspec\Orm\Engine;
use Polyspec\Orm\OrmException;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;

/**
 * Compiles the case's request in each dialect and compares it with the expected value.
 * A bind slot is compared by its number if it is a param slot, and as the whole slot otherwise.
 */
function plannerCase(string $root, array $fixture, string $id): void
{
    $found = array_values(array_filter($fixture['cases'], static fn(array $c): bool => $c['id'] === $id));
    Assert::assertTrue(count($found) === 1, "planner.json has " . count($found) . " cases $id");
    $case = $found[0];
    Assert::assertTrue($case['operation'] === 'compile', "case $id has operation {$case['operation']}");
    Assert::assertTrue(
        ($case['schema'] ?? '') !== '',
        "case $id names no schema; give it the repository path of its dbspec document"
    );
    $model = RuntimeModel::build(RuntimeModel::files(["$root/{$case['schema']}"]));
    $request = ['manifest_hash' => $model->manifestHash] + $case['input'];
    foreach (['mysql', 'postgres', 'sqlite'] as $dialect) {
        $engine = new Engine($model, $dialect, 8);
        if (isset($case['expected']['error'])) {
            $code = coverageCode(fn() => $engine->compile($request));
            Assert::assertTrue(
                $code === $case['expected']['error'],
                "$dialect $id is $code, want {$case['expected']['error']}"
            );
            continue;
        }
        $plan = $engine->compile($request);
        // key is the fixture's sorted key order.
        $statements = array_map(static fn(array $step): array => [
            'role' => $step['role'],
            'slots' => array_map(static function (array $slot): array {
                if ($slot['from'] === 'parent') {
                    return ['from' => 'parent', 'key_types' => $slot['key_types']];
                }
                $type = $slot['col_type'] ?? '';
                $out = ['from' => $slot['from']];
                // A varchar param slot carries its length.
                if ($slot['from'] === 'param' && $type === 'varchar') {
                    $out['length'] = $slot['length'] ?? 0;
                }
                // An assignment slot of a non-null column says so.
                if (!empty($slot['not_null'])) {
                    $out['not_null'] = true;
                }
                if ($slot['from'] === 'param') {
                    $out['param'] = $slot['param'];
                }
                // A datetime or time slot carries its fraction digits (sorted key order).
                if ($type === 'datetime' || $type === 'time') {
                    $out['precision'] = $slot['precision'] ?? 0;
                }
                $out['type'] = $type;
                return $out;
            }, $step['bind_slots']),
            'sql' => $step['sql'],
            'tables' => $step['tables'],
        ], $plan['steps']);
        Assert::assertTrue(
            $statements === $case['expected'][$dialect],
            "$dialect $id statements " . json_encode($statements)
        );
    }
}

/** Validates the request of a param_uses case and compares the uses of each parameter. */
function paramUsesCase(string $root, array $fixture, string $id): void
{
    $found = array_values(array_filter($fixture['cases'], static fn(array $c): bool => $c['id'] === $id));
    Assert::assertTrue(count($found) === 1, "planner.json has " . count($found) . " cases $id");
    $case = $found[0];
    Assert::assertTrue($case['operation'] === 'param_uses', "case $id has operation {$case['operation']}");
    $model = RuntimeModel::build(RuntimeModel::files(["$root/{$case['schema']}"]));
    $request = ['manifest_hash' => $model->manifestHash] + $case['input'];
    $validator = new Validator($model);
    $validator->validate($request);
    // key is the fixture's sorted key order.
    $uses = array_map(static fn(array $list): array => array_map(static fn(array $u): array => $u['column'] === null
        ? ['type' => $u['type']]
        : ($u['assign'] ? ['assign' => true] : []) + [
            'column' => $u['column']['name'],
            'length' => $u['column']['length'] ?? 0,
            'null' => $u['column']['nullable'],
            'precision' => $u['column']['precision'] ?? 0,
            'scale' => $u['column']['scale'] ?? 0,
            'type' => $u['type'],
        ], $list), $validator->paramUses($request));
    Assert::assertTrue($uses === $case['expected']['uses'], "$id param uses " . json_encode($uses));
}

#[Small]
final class CoveragePlannerTest extends TestCase
{
    public function testPlannerStatement(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_statement');
    }

    public function testPlannerCount(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_count');
    }

    public function testPlannerContainsBinaryCollation(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_contains_binary_collation');
    }

    public function testPlannerContainsAsciiFold(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_contains_ascii_fold');
    }

    public function testPlannerRejectsUnknownColumn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_unknown_column');
    }

    public function testPlannerRestore(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore');
    }

    public function testPlannerTables(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_tables');
    }

    public function testPlannerRestoreRejectsNonKey(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_rejects_non_key');
    }

    public function testPlannerRestoreKeyFromSet(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_key_from_set');
    }

    public function testPlannerRestoreExtraCondition(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_extra_condition');
    }

    public function testPlannerRestorePrimaryKeyFirst(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_primary_key_first');
    }

    public function testPlannerRestoreFirstUniqueByName(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_first_unique_by_name');
    }

    public function testPlannerBindTypesSelect(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_bind_types_select');
    }

    public function testPlannerBindTypesUpdate(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_bind_types_update');
    }

    public function testPlannerBindTypesInsert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_bind_types_insert');
    }

    public function testPlannerTimeSelect(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_time_select');
    }

    public function testPlannerTimeInsert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_time_insert');
    }

    public function testPlannerUuidSelect(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_uuid_select');
    }

    public function testPlannerUuidInsert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_uuid_insert');
    }

    public function testPlannerClockCompare(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_clock_compare');
    }

    public function testPlannerClockInsert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_clock_insert');
    }

    public function testPlannerParentKeyTypes(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_parent_key_types');
    }

    public function testPlannerNotGroup(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_not_group');
    }

    public function testPlannerRejectsTopNot(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_top_not');
    }

    public function testPlannerRejectsTopGroupConn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_top_group_conn');
    }

    public function testPlannerRejectsFirstItemConn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_first_item_conn');
    }

    public function testPlannerColumnRefs(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_column_refs');
    }

    public function testPlannerRejectsRefUnknownColumn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_ref_unknown_column');
    }

    public function testPlannerRejectsOuterRefOutsideSubquery(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_outer_ref_outside_subquery');
    }

    public function testPlannerRejectsUnjoinedRef(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_unjoined_ref');
    }

    public function testPlannerRefPathAbsent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_ref_path_absent');
    }

    public function testPlannerGroupByCount(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_by_count');
    }

    public function testPlannerGroupCountOrderColumn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_count_order_column');
    }

    public function testPlannerGroupCountOrderColumnFunction(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_count_order_column_function');
    }

    public function testPlannerGroupCountOrderRandom(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_count_order_random');
    }

    public function testPlannerRejectsGroupByAll(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_all');
    }

    public function testPlannerRejectsGroupBySum(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_sum');
    }

    public function testPlannerRejectsGroupByJoin(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_join');
    }

    public function testPlannerRejectsGroupBySubquery(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_subquery');
    }

    public function testPlannerRejectsGroupOrderNonGroupColumn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_order_non_group_column');
    }

    public function testPlannerRejectsNullableKeyBy(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_nullable_key_by');
    }

    public function testPlannerKeyByEmptyIsAbsent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_key_by_empty_is_absent');
    }

    public function testPlannerInsertByValue(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_insert_by_value');
    }

    public function testPlannerInsertOnDuplicatePlus(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_insert_on_duplicate_plus');
    }

    public function testPlannerRejectsInsertSetPlus(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_insert_set_plus');
    }

    public function testPlannerRejectsInsertSetMinus(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_insert_set_minus');
    }

    public function testPlannerIpEqColIp(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_ip_eq_col_ip');
    }

    public function testPlannerRejectsBoolGtCol(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_bool_gt_col');
    }

    public function testPlannerRejectsIpGtCol(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_ip_gt_col');
    }

    public function testPlannerRejectsAesEqCol(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_aes_eq_col');
    }

    public function testPlannerColPairIntegers(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_col_pair_integers');
    }

    public function testPlannerRejectsColPairIntegerVarchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_col_pair_integer_varchar');
    }

    public function testPlannerRejectsInSubqueryIntegerVarchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_in_subquery_integer_varchar');
    }

    public function testPlannerRejectsJoinIntegerVarchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_join_integer_varchar');
    }

    public function testPlannerRejectsRelationIntegerVarchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_relation_integer_varchar');
    }

    public function testPlannerRejectsUpsertPrimaryAndUniqueKey(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_upsert_primary_and_unique_key');
    }

    public function testPlannerRejectsUpsertUniqueKeyNotAssigned(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_upsert_unique_key_not_assigned');
    }

    public function testPlannerRejectsUpsertWithoutAKey(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_upsert_without_a_key');
    }

    public function testPlannerOrderNullableColumn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_column');
    }

    public function testPlannerOrderNotNullColumn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_not_null_column');
    }

    public function testPlannerOrderNullableColumnFunction(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_column_function');
    }

    public function testPlannerOrderNullableGroupCount(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_group_count');
    }

    public function testPlannerOrderNullableLimitPerParent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_limit_per_parent');
    }

    public function testPlannerScalarColumnSubquery(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_scalar_column_subquery');
    }

    public function testPlannerRejectsScalarColumnSubqueryWithoutLimit(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_scalar_column_subquery_without_limit');
    }

    public function testPlannerRejectsScalarColumnSubqueryWithoutKeyOrder(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_scalar_column_subquery_without_key_order');
    }

    public function testPlannerRejectsInSubqueryLimit(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_in_subquery_limit');
    }

    public function testParamUsesColumnFunction(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_column_function');
    }

    public function testParamUsesInterval(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_interval');
    }

    public function testParamUsesContains(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_contains');
    }

    public function testParamUsesIfParent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_if_parent');
    }

    public function testParamUsesOptimistic(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_optimistic');
    }

    public function testPlannerJoinInnerSoftDelete(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_join_inner_soft_delete');
    }

    public function testPlannerJoinLeftSoftDelete(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_join_left_soft_delete');
    }

    public function testPlannerJoinOnSoftDelete(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_join_on_soft_delete');
    }

    public function testPlannerForceIndex(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_force_index');
    }

    public function testPlannerValueFunctionToday(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_value_function_today');
    }

    public function testPlannerColumnFunctionDate(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_column_function_date');
    }

    public function testPlannerRejectsColumnFunctionOnVarchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_column_function_on_varchar');
    }

    public function testPlannerRejectsStyledColumnEquality(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_styled_column_equality');
    }

    public function testPlannerStyledColumnIsNull(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_styled_column_is_null');
    }
}
