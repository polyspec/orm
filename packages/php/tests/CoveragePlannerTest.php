<?php

declare(strict_types=1);

// planner feature coverage: the requests in contracts/fixtures/planner.json,
// with the manifest hash of that case's schema document added, are compiled by the PHP engine of each dialect,
// and the statement's role, sql, bind slots (source, param number, type), or error
// code are compared with the fixture.

require_once __DIR__ . '/coverage_cases.php';

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
    public function test_planner_statement(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_statement');
    }

    public function test_planner_count(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_count');
    }

    public function test_planner_contains_binary_collation(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_contains_binary_collation');
    }

    public function test_planner_contains_ascii_fold(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_contains_ascii_fold');
    }

    public function test_planner_rejects_unknown_column(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_unknown_column');
    }

    public function test_planner_restore(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore');
    }

    public function test_planner_tables(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_tables');
    }

    public function test_planner_restore_rejects_non_key(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_rejects_non_key');
    }

    public function test_planner_restore_key_from_set(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_key_from_set');
    }

    public function test_planner_restore_extra_condition(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_extra_condition');
    }

    public function test_planner_restore_primary_key_first(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_primary_key_first');
    }

    public function test_planner_restore_first_unique_by_name(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_restore_first_unique_by_name');
    }

    public function test_planner_bind_types_select(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_bind_types_select');
    }

    public function test_planner_bind_types_update(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_bind_types_update');
    }

    public function test_planner_bind_types_insert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_bind_types_insert');
    }

    public function test_planner_time_select(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_time_select');
    }

    public function test_planner_time_insert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_time_insert');
    }

    public function test_planner_uuid_select(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_uuid_select');
    }

    public function test_planner_uuid_insert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_uuid_insert');
    }

    public function test_planner_clock_compare(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_clock_compare');
    }

    public function test_planner_clock_insert(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_clock_insert');
    }

    public function test_planner_parent_key_types(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_parent_key_types');
    }

    public function test_planner_not_group(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_not_group');
    }

    public function test_planner_rejects_top_not(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_top_not');
    }

    public function test_planner_rejects_top_group_conn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_top_group_conn');
    }

    public function test_planner_rejects_first_item_conn(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_first_item_conn');
    }

    public function test_planner_column_refs(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_column_refs');
    }

    public function test_planner_rejects_ref_unknown_column(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_ref_unknown_column');
    }

    public function test_planner_rejects_outer_ref_outside_subquery(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_outer_ref_outside_subquery');
    }

    public function test_planner_rejects_unjoined_ref(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_unjoined_ref');
    }

    public function test_planner_ref_path_absent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_ref_path_absent');
    }

    public function test_planner_group_by_count(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_by_count');
    }

    public function test_planner_group_count_order_column(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_count_order_column');
    }

    public function test_planner_group_count_order_column_function(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_count_order_column_function');
    }

    public function test_planner_group_count_order_random(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_group_count_order_random');
    }

    public function test_planner_rejects_group_by_all(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_all');
    }

    public function test_planner_rejects_group_by_sum(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_sum');
    }

    public function test_planner_rejects_group_by_join(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_join');
    }

    public function test_planner_rejects_group_by_subquery(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_by_subquery');
    }

    public function test_planner_rejects_group_order_non_group_column(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_group_order_non_group_column');
    }

    public function test_planner_rejects_nullable_key_by(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_nullable_key_by');
    }

    public function test_planner_key_by_empty_is_absent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_key_by_empty_is_absent');
    }

    public function test_planner_insert_by_value(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_insert_by_value');
    }

    public function test_planner_insert_on_duplicate_plus(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_insert_on_duplicate_plus');
    }

    public function test_planner_rejects_insert_set_plus(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_insert_set_plus');
    }

    public function test_planner_rejects_insert_set_minus(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_insert_set_minus');
    }

    public function test_planner_ip_eq_col_ip(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_ip_eq_col_ip');
    }

    public function test_planner_rejects_bool_gt_col(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_bool_gt_col');
    }

    public function test_planner_rejects_ip_gt_col(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_ip_gt_col');
    }

    public function test_planner_rejects_aes_eq_col(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_aes_eq_col');
    }

    public function test_planner_col_pair_integers(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_col_pair_integers');
    }

    public function test_planner_rejects_col_pair_integer_varchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_col_pair_integer_varchar');
    }

    public function test_planner_rejects_in_subquery_integer_varchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_in_subquery_integer_varchar');
    }

    public function test_planner_rejects_join_integer_varchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_join_integer_varchar');
    }

    public function test_planner_rejects_relation_integer_varchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_relation_integer_varchar');
    }

    public function test_planner_rejects_upsert_primary_and_unique_key(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_upsert_primary_and_unique_key');
    }

    public function test_planner_rejects_upsert_unique_key_not_assigned(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_upsert_unique_key_not_assigned');
    }

    public function test_planner_rejects_upsert_without_a_key(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_upsert_without_a_key');
    }

    public function test_planner_order_nullable_column(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_column');
    }

    public function test_planner_order_not_null_column(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_not_null_column');
    }

    public function test_planner_order_nullable_column_function(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_column_function');
    }

    public function test_planner_order_nullable_group_count(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_group_count');
    }

    public function test_planner_order_nullable_limit_per_parent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_order_nullable_limit_per_parent');
    }

    public function test_planner_scalar_column_subquery(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_scalar_column_subquery');
    }

    public function test_planner_rejects_scalar_column_subquery_without_limit(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_scalar_column_subquery_without_limit');
    }

    public function test_planner_rejects_scalar_column_subquery_without_key_order(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_scalar_column_subquery_without_key_order');
    }

    public function test_planner_rejects_in_subquery_limit(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_in_subquery_limit');
    }

    public function test_param_uses_column_function(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_column_function');
    }

    public function test_param_uses_interval(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_interval');
    }

    public function test_param_uses_contains(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_contains');
    }

    public function test_param_uses_if_parent(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_if_parent');
    }

    public function test_param_uses_optimistic(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        paramUsesCase($root, $fixture, 'param_uses_optimistic');
    }

    public function test_planner_join_inner_soft_delete(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_join_inner_soft_delete');
    }

    public function test_planner_join_left_soft_delete(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_join_left_soft_delete');
    }

    public function test_planner_join_on_soft_delete(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_join_on_soft_delete');
    }

    public function test_planner_force_index(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_force_index');
    }

    public function test_planner_value_function_today(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_value_function_today');
    }

    public function test_planner_column_function_date(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_column_function_date');
    }

    public function test_planner_rejects_column_function_on_varchar(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_column_function_on_varchar');
    }

    public function test_planner_rejects_styled_column_equality(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_rejects_styled_column_equality');
    }

    public function test_planner_styled_column_is_null(): void
    {
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        plannerCase($root, $fixture, 'planner_styled_column_is_null');
    }
}
