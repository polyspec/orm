<?php

declare(strict_types=1);

namespace Polyspec\Orm\Tests;

use Polyspec\Orm\Engine;
use Polyspec\Orm\Planner;
use Polyspec\Orm\RuntimeModel;
use Polyspec\Orm\Validator;
use PHPUnit\Framework\Assert;
use PHPUnit\Framework\Attributes\Small;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

#[Small]
final class CoveragePlannerExtensionTest extends TestCase
{
    private function runPlannerCoverageCase(string $id): void
    {
        require_once dirname(__DIR__, 2) . '/php/tests/CoveragePlannerTest.php';
        Assert::assertTrue((new ReflectionClass(Planner::class))->isInternal());
        Assert::assertTrue((new ReflectionClass(Validator::class))->isInternal());

        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        $found = array_values(array_filter(
            $fixture['cases'],
            static fn(array $case): bool => $case['id'] === $id
        ));
        Assert::assertCount(1, $found, "planner.json has " . count($found) . " cases $id");
        if ($found[0]['operation'] === 'compile') {
            plannerCase($root, $fixture, $id);
            return;
        }
        paramUsesCase($root, $fixture, $id);
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_statement(): void
    {
        $this->runPlannerCoverageCase('planner_statement');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_count(): void
    {
        $this->runPlannerCoverageCase('planner_count');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_unknown_column(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_unknown_column');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_restore(): void
    {
        $this->runPlannerCoverageCase('planner_restore');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    // Requirements: PRT-37.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_tables(): void
    {
        $this->runPlannerCoverageCase('planner_tables');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_restore_rejects_non_key(): void
    {
        $this->runPlannerCoverageCase('planner_restore_rejects_non_key');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_restore_key_from_set(): void
    {
        $this->runPlannerCoverageCase('planner_restore_key_from_set');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_restore_extra_condition(): void
    {
        $this->runPlannerCoverageCase('planner_restore_extra_condition');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_restore_primary_key_first(): void
    {
        $this->runPlannerCoverageCase('planner_restore_primary_key_first');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_restore_first_unique_by_name(): void
    {
        $this->runPlannerCoverageCase('planner_restore_first_unique_by_name');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_bind_types_select(): void
    {
        $this->runPlannerCoverageCase('planner_bind_types_select');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_bind_types_update(): void
    {
        $this->runPlannerCoverageCase('planner_bind_types_update');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_bind_types_insert(): void
    {
        $this->runPlannerCoverageCase('planner_bind_types_insert');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_time_select(): void
    {
        $this->runPlannerCoverageCase('planner_time_select');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_time_insert(): void
    {
        $this->runPlannerCoverageCase('planner_time_insert');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_uuid_select(): void
    {
        $this->runPlannerCoverageCase('planner_uuid_select');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_uuid_insert(): void
    {
        $this->runPlannerCoverageCase('planner_uuid_insert');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_clock_compare(): void
    {
        $this->runPlannerCoverageCase('planner_clock_compare');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_clock_insert(): void
    {
        $this->runPlannerCoverageCase('planner_clock_insert');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_parent_key_types(): void
    {
        $this->runPlannerCoverageCase('planner_parent_key_types');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_not_group(): void
    {
        $this->runPlannerCoverageCase('planner_not_group');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_top_not(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_top_not');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_top_group_conn(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_top_group_conn');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_first_item_conn(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_first_item_conn');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_column_refs(): void
    {
        $this->runPlannerCoverageCase('planner_column_refs');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_ref_unknown_column(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_ref_unknown_column');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_outer_ref_outside_subquery(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_outer_ref_outside_subquery');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_unjoined_ref(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_unjoined_ref');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_ref_path_absent(): void
    {
        $this->runPlannerCoverageCase('planner_ref_path_absent');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_group_by_count(): void
    {
        $this->runPlannerCoverageCase('planner_group_by_count');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_group_count_order_column(): void
    {
        $this->runPlannerCoverageCase('planner_group_count_order_column');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_group_count_order_column_function(): void
    {
        $this->runPlannerCoverageCase('planner_group_count_order_column_function');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_group_count_order_random(): void
    {
        $this->runPlannerCoverageCase('planner_group_count_order_random');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_group_by_all(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_group_by_all');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_group_by_sum(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_group_by_sum');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_group_by_join(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_group_by_join');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_group_by_subquery(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_group_by_subquery');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_group_order_non_group_column(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_group_order_non_group_column');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_nullable_key_by(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_nullable_key_by');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_key_by_empty_is_absent(): void
    {
        $this->runPlannerCoverageCase('planner_key_by_empty_is_absent');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_insert_by_value(): void
    {
        $this->runPlannerCoverageCase('planner_insert_by_value');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_insert_on_duplicate_plus(): void
    {
        $this->runPlannerCoverageCase('planner_insert_on_duplicate_plus');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_insert_set_plus(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_insert_set_plus');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_insert_set_minus(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_insert_set_minus');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_ip_eq_col_ip(): void
    {
        $this->runPlannerCoverageCase('planner_ip_eq_col_ip');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_bool_gt_col(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_bool_gt_col');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_ip_gt_col(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_ip_gt_col');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_aes_eq_col(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_aes_eq_col');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_col_pair_integers(): void
    {
        $this->runPlannerCoverageCase('planner_col_pair_integers');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_col_pair_integer_varchar(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_col_pair_integer_varchar');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_in_subquery_integer_varchar(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_in_subquery_integer_varchar');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_join_integer_varchar(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_join_integer_varchar');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_relation_integer_varchar(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_relation_integer_varchar');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_upsert_primary_and_unique_key(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_upsert_primary_and_unique_key');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_upsert_unique_key_not_assigned(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_upsert_unique_key_not_assigned');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_upsert_without_a_key(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_upsert_without_a_key');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_order_nullable_column(): void
    {
        $this->runPlannerCoverageCase('planner_order_nullable_column');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_order_not_null_column(): void
    {
        $this->runPlannerCoverageCase('planner_order_not_null_column');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_order_nullable_column_function(): void
    {
        $this->runPlannerCoverageCase('planner_order_nullable_column_function');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_order_nullable_group_count(): void
    {
        $this->runPlannerCoverageCase('planner_order_nullable_group_count');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_order_nullable_limit_per_parent(): void
    {
        $this->runPlannerCoverageCase('planner_order_nullable_limit_per_parent');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    // Requirements: PRT-78.
    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_scalar_column_subquery(): void
    {
        $this->runPlannerCoverageCase('planner_scalar_column_subquery');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_scalar_column_subquery_without_limit(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_scalar_column_subquery_without_limit');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_scalar_column_subquery_without_key_order(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_scalar_column_subquery_without_key_order');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_in_subquery_limit(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_in_subquery_limit');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_join_inner_soft_delete(): void
    {
        $this->runPlannerCoverageCase('planner_join_inner_soft_delete');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_join_left_soft_delete(): void
    {
        $this->runPlannerCoverageCase('planner_join_left_soft_delete');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_join_on_soft_delete(): void
    {
        $this->runPlannerCoverageCase('planner_join_on_soft_delete');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_force_index(): void
    {
        $this->runPlannerCoverageCase('planner_force_index');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_value_function_today(): void
    {
        $this->runPlannerCoverageCase('planner_value_function_today');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_column_function_date(): void
    {
        $this->runPlannerCoverageCase('planner_column_function_date');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_column_function_on_varchar(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_column_function_on_varchar');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_rejects_styled_column_equality(): void
    {
        $this->runPlannerCoverageCase('planner_rejects_styled_column_equality');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_styled_column_is_null(): void
    {
        $this->runPlannerCoverageCase('planner_styled_column_is_null');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_contains_ascii_fold(): void
    {
        $this->runPlannerCoverageCase('planner_contains_ascii_fold');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_planner_contains_binary_collation(): void
    {
        $this->runPlannerCoverageCase('planner_contains_binary_collation');

        require_once dirname(__DIR__, 2) . '/php/tests/CoveragePlannerTest.php';
        $root = dirname(__DIR__, 3);
        $fixture = coverageJson("$root/contracts/fixtures/planner.json");
        $found = array_values(array_filter(
            $fixture['cases'],
            static fn(array $case): bool => $case['id'] === 'planner_contains_binary_collation'
        ));
        Assert::assertCount(1, $found);
        $case = $found[0];
        $model = RuntimeModel::build(RuntimeModel::files(["$root/{$case['schema']}"]));
        $request = ['manifest_hash' => $model->manifestHash] + $case['input'];
        Assert::assertTrue((new ReflectionClass(Engine::class))->isInternal());
        $plan = (new Engine($model, 'sqlite', 8))->plan($request);

        Assert::assertSame($case['expected']['sqlite'][0]['sql'], $plan['steps'][0]['sql']);
        Assert::assertCount(1, $plan['steps'][0]['bind_slots']);
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_param_uses_column_function(): void
    {
        $this->runPlannerCoverageCase('param_uses_column_function');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_param_uses_interval(): void
    {
        $this->runPlannerCoverageCase('param_uses_interval');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_param_uses_contains(): void
    {
        $this->runPlannerCoverageCase('param_uses_contains');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_param_uses_if_parent(): void
    {
        $this->runPlannerCoverageCase('param_uses_if_parent');
    }

    // phpcs:ignore PSR1.Methods.CamelCapsMethodName.NotCamelCaps -- feature IDs require the test method to preserve underscores.
    public function test_param_uses_optimistic(): void
    {
        $this->runPlannerCoverageCase('param_uses_optimistic');
    }
}
