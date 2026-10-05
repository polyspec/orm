// planner coverage: contracts/fixtures/planner.json 의 request 를 schema/bench.dbs 의 manifest hash
// 와 함께 dialect 마다 client engine 으로 compile 해서 statement (role, sql, bind slot 의 출처, param 번호, type)
// 또는 오류 code 가 기대값과 같은지 확인한다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { repositoryRoot, runCases } from './coverage_case.mjs';

const fixture = JSON.parse(await readFile(join(repositoryRoot, 'contracts/fixtures/planner.json'), 'utf8'));
const parsed = parseDbspec(await readFile(join(repositoryRoot, 'schema/bench.dbs'), 'utf8'), {});
assert.deepEqual(parsed.diagnostics, [], 'schema/bench.dbs parses');
const { manifest } = dbspecManifest([parsed.document]);
const model = registerModel(manifest.manifestText, manifest.manifestHash);
const dialects = ['mysql', 'postgres', 'sqlite'];

/** A bind slot's source and type: the request value number of a param slot, the key types of a parent slot. */
function plannerSlot(slot) {
  if (slot.from === 'param') return { from: slot.from, param: slot.param, type: slot.col_type };
  if (slot.from === 'parent') return { from: slot.from, key_types: slot.key_types };
  return { from: slot.from, type: slot.col_type };
}

/** Compiles the request of a fixture case in every dialect and compares the expectation. */
function compileCase(id) {
  const found = fixture.cases.filter(c => c.id === id);
  assert.equal(found.length, 1, `planner.json holds case ${id} once`);
  const c = found[0];
  assert.equal(c.operation, 'compile', `operation of case ${id}`);
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
  async planner_rejects_unknown_column() { compileCase('planner_rejects_unknown_column'); },
  async planner_restore() { compileCase('planner_restore'); },
  async planner_tables() { compileCase('planner_tables'); },
  async planner_restore_rejects_non_key() { compileCase('planner_restore_rejects_non_key'); },
  async planner_bind_types_select() { compileCase('planner_bind_types_select'); },
  async planner_bind_types_update() { compileCase('planner_bind_types_update'); },
  async planner_bind_types_insert() { compileCase('planner_bind_types_insert'); },
  async planner_parent_key_types() { compileCase('planner_parent_key_types'); },
}, 60_000);
