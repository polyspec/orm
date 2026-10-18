// planner coverage: the request of contracts/fixtures/planner.json is compiled with the client engine for each dialect, together with the manifest hash
// of the schema document of that case, and the statements (role, sql, source of the bind slot, param number, type)
// or the error code is checked to equal the expected value.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { paramUses } from '../dist/engine/params.js';
import { validate } from '../dist/engine/validate.js';
import { repositoryRoot, runCases } from './coverage_case.mjs';

const fixture = JSON.parse(await readFile(join(repositoryRoot, 'contracts/fixtures/planner.json'), 'utf8'));
/** The manifest and runtime model of each schema document that a case names, by repository path. */
const schemas = new Map();
for (const c of fixture.cases) {
  if (typeof c.schema !== 'string' || c.schema === '') throw new Error(`case ${c.id} names no schema; give it the repository path of its dbspec document`);
  if (schemas.has(c.schema)) continue;
  const parsed = parseDbspec(await readFile(join(repositoryRoot, c.schema), 'utf8'), {});
  assert.deepEqual(parsed.diagnostics, [], `${c.schema} parses`);
  const { manifest } = dbspecManifest([parsed.document]);
  schemas.set(c.schema, { manifest, model: registerModel(manifest.manifestText, manifest.manifestHash) });
}
const dialects = ['mysql', 'postgres', 'sqlite'];

/** A bind slot's source and type: the request value number of a param slot, the key types of a parent slot. */
function plannerSlot(slot) {
  if (slot.from === 'parent') return { from: slot.from, key_types: slot.key_types };
  const out = slot.from === 'param' ? { from: slot.from, param: slot.param, type: slot.col_type } : { from: slot.from, type: slot.col_type };
  // A datetime or time slot carries its fraction digits.
  if (slot.col_type === 'datetime' || slot.col_type === 'time') out.precision = slot.precision ?? 0;
  // A varchar param slot carries its length.
  if (slot.from === 'param' && slot.col_type === 'varchar') out.length = slot.length ?? 0;
  // An assignment slot of a non-null column says so.
  if (slot.not_null === true) out.not_null = true;
  return out;
}

/** Validates the request of a param_uses case and compares the uses of each parameter. */
function paramUsesCase(id) {
  const found = fixture.cases.filter(c => c.id === id);
  assert.equal(found.length, 1, `planner.json holds case ${id} once`);
  const c = found[0];
  assert.equal(c.operation, 'param_uses', `operation of case ${id}`);
  const { manifest, model } = schemas.get(c.schema);
  const request = { ...structuredClone(c.input), manifest_hash: manifest.manifestHash };
  validate(model, request);
  const uses = paramUses(model, request).map(list => list.map(u => u.column === undefined
    ? { type: u.type }
    : { type: u.type, ...(u.assign === true ? { assign: true } : {}), column: u.column.name, length: u.column.length, null: u.column.nullable, precision: u.column.precision, scale: u.column.scale }));
  assert.deepEqual(uses, c.expected.uses, 'param uses');
}

/** Compiles the request of a fixture case in every dialect and compares the expectation. */
function compileCase(id) {
  const found = fixture.cases.filter(c => c.id === id);
  assert.equal(found.length, 1, `planner.json holds case ${id} once`);
  const c = found[0];
  assert.equal(c.operation, 'compile', `operation of case ${id}`);
  const { manifest, model } = schemas.get(c.schema);
  const request = { ...c.input, manifest_hash: manifest.manifestHash };
  for (const dialect of dialects) {
    const engine = new Engine(model, dialect);
    if (Object.hasOwn(c.expected, 'error')) {
      assert.throws(() => engine.compile(request), error => error?.code === c.expected.error, `${dialect} rejects with ${c.expected.error}`);
      continue;
    }
    const plan = engine.compile(request);
    const statements = plan.steps.map(step => ({ role: step.role, sql: step.sql, slots: step.bind_slots.map(plannerSlot), tables: step.tables }));
    assert.deepEqual(statements, c.expected[dialect], `${dialect} statements`);
  }
}

await runCases('coverage_planner.mjs', {
  async planner_statement() { compileCase('planner_statement'); },
  async planner_count() { compileCase('planner_count'); },
  async planner_contains_binary_collation() { compileCase('planner_contains_binary_collation'); },
  async planner_contains_ascii_fold() { compileCase('planner_contains_ascii_fold'); },
  async planner_rejects_unknown_column() { compileCase('planner_rejects_unknown_column'); },
  async planner_restore() { compileCase('planner_restore'); },
  async planner_tables() { compileCase('planner_tables'); },
  async planner_restore_rejects_non_key() { compileCase('planner_restore_rejects_non_key'); },
  async planner_restore_key_from_set() { compileCase('planner_restore_key_from_set'); },
  async planner_restore_extra_condition() { compileCase('planner_restore_extra_condition'); },
  async planner_restore_primary_key_first() { compileCase('planner_restore_primary_key_first'); },
  async planner_restore_first_unique_by_name() { compileCase('planner_restore_first_unique_by_name'); },
  async planner_bind_types_select() { compileCase('planner_bind_types_select'); },
  async planner_bind_types_update() { compileCase('planner_bind_types_update'); },
  async planner_bind_types_insert() { compileCase('planner_bind_types_insert'); },
  async planner_time_select() { compileCase('planner_time_select'); },
  async planner_time_insert() { compileCase('planner_time_insert'); },
  async planner_uuid_select() { compileCase('planner_uuid_select'); },
  async planner_uuid_insert() { compileCase('planner_uuid_insert'); },
  async planner_clock_compare() { compileCase('planner_clock_compare'); },
  async planner_clock_insert() { compileCase('planner_clock_insert'); },
  async planner_parent_key_types() { compileCase('planner_parent_key_types'); },
  async planner_not_group() { compileCase('planner_not_group'); },
  async planner_rejects_top_not() { compileCase('planner_rejects_top_not'); },
  async planner_rejects_top_group_conn() { compileCase('planner_rejects_top_group_conn'); },
  async planner_rejects_first_item_conn() { compileCase('planner_rejects_first_item_conn'); },
  async planner_column_refs() { compileCase('planner_column_refs'); },
  async planner_rejects_ref_unknown_column() { compileCase('planner_rejects_ref_unknown_column'); },
  async planner_rejects_outer_ref_outside_subquery() { compileCase('planner_rejects_outer_ref_outside_subquery'); },
  async planner_rejects_unjoined_ref() { compileCase('planner_rejects_unjoined_ref'); },
  async planner_ref_path_absent() { compileCase('planner_ref_path_absent'); },
  async planner_group_by_count() { compileCase('planner_group_by_count'); },
  async planner_group_count_order_column() { compileCase('planner_group_count_order_column'); },
  async planner_group_count_order_column_function() { compileCase('planner_group_count_order_column_function'); },
  async planner_group_count_order_random() { compileCase('planner_group_count_order_random'); },
  async planner_rejects_group_by_all() { compileCase('planner_rejects_group_by_all'); },
  async planner_rejects_group_by_sum() { compileCase('planner_rejects_group_by_sum'); },
  async planner_rejects_group_by_join() { compileCase('planner_rejects_group_by_join'); },
  async planner_rejects_group_by_subquery() { compileCase('planner_rejects_group_by_subquery'); },
  async planner_rejects_group_order_non_group_column() { compileCase('planner_rejects_group_order_non_group_column'); },
  async planner_rejects_nullable_key_by() { compileCase('planner_rejects_nullable_key_by'); },
  async planner_key_by_empty_is_absent() { compileCase('planner_key_by_empty_is_absent'); },
  async planner_insert_by_value() { compileCase('planner_insert_by_value'); },
  async planner_insert_on_duplicate_plus() { compileCase('planner_insert_on_duplicate_plus'); },
  async planner_rejects_insert_set_plus() { compileCase('planner_rejects_insert_set_plus'); },
  async planner_rejects_insert_set_minus() { compileCase('planner_rejects_insert_set_minus'); },
  async planner_ip_eq_col_ip() { compileCase('planner_ip_eq_col_ip'); },
  async planner_rejects_bool_gt_col() { compileCase('planner_rejects_bool_gt_col'); },
  async planner_rejects_ip_gt_col() { compileCase('planner_rejects_ip_gt_col'); },
  async planner_rejects_aes_eq_col() { compileCase('planner_rejects_aes_eq_col'); },
  async planner_col_pair_integers() { compileCase('planner_col_pair_integers'); },
  async planner_rejects_col_pair_integer_varchar() { compileCase('planner_rejects_col_pair_integer_varchar'); },
  async planner_rejects_in_subquery_integer_varchar() { compileCase('planner_rejects_in_subquery_integer_varchar'); },
  async planner_rejects_join_integer_varchar() { compileCase('planner_rejects_join_integer_varchar'); },
  async planner_rejects_relation_integer_varchar() { compileCase('planner_rejects_relation_integer_varchar'); },
  async planner_rejects_upsert_primary_and_unique_key() { compileCase('planner_rejects_upsert_primary_and_unique_key'); },
  async planner_rejects_upsert_unique_key_not_assigned() { compileCase('planner_rejects_upsert_unique_key_not_assigned'); },
  async planner_rejects_upsert_without_a_key() { compileCase('planner_rejects_upsert_without_a_key'); },
  async planner_order_nullable_column() { compileCase('planner_order_nullable_column'); },
  async planner_order_not_null_column() { compileCase('planner_order_not_null_column'); },
  async planner_order_nullable_column_function() { compileCase('planner_order_nullable_column_function'); },
  async planner_order_nullable_group_count() { compileCase('planner_order_nullable_group_count'); },
  async planner_order_nullable_limit_per_parent() { compileCase('planner_order_nullable_limit_per_parent'); },
  async planner_scalar_column_subquery() { compileCase('planner_scalar_column_subquery'); },
  async planner_rejects_scalar_column_subquery_without_limit() { compileCase('planner_rejects_scalar_column_subquery_without_limit'); },
  async planner_rejects_scalar_column_subquery_without_key_order() { compileCase('planner_rejects_scalar_column_subquery_without_key_order'); },
  async planner_rejects_in_subquery_limit() { compileCase('planner_rejects_in_subquery_limit'); },
  async param_uses_column_function() { paramUsesCase('param_uses_column_function'); },
  async param_uses_interval() { paramUsesCase('param_uses_interval'); },
  async param_uses_contains() { paramUsesCase('param_uses_contains'); },
  async param_uses_if_parent() { paramUsesCase('param_uses_if_parent'); },
  async param_uses_optimistic() { paramUsesCase('param_uses_optimistic'); },
  async planner_join_inner_soft_delete() { compileCase('planner_join_inner_soft_delete'); },
  async planner_join_left_soft_delete() { compileCase('planner_join_left_soft_delete'); },
  async planner_join_on_soft_delete() { compileCase('planner_join_on_soft_delete'); },
}, 60_000);
