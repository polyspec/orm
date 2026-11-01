// planner coverage of the param_uses cases of contracts/fixtures/planner.json: the compile cases are the recipe tests/planner/compile.json.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
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

await runCases('coverage_planner.mjs', {
  // Requirements: DIA-31, PRT-67.
  async param_uses_column_function() { paramUsesCase('param_uses_column_function'); },
  // Requirements: DIA-31, PRT-67.
  async param_uses_interval() { paramUsesCase('param_uses_interval'); },
  // Requirements: DIA-31, PRT-67.
  async param_uses_contains() { paramUsesCase('param_uses_contains'); },
  // Requirements: DIA-31, PRT-67.
  async param_uses_if_parent() { paramUsesCase('param_uses_if_parent'); },
  // Requirements: DIA-31, PRT-67.
  async param_uses_optimistic() { paramUsesCase('param_uses_optimistic'); },
}, 60_000);
