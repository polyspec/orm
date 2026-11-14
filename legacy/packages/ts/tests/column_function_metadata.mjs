import assert from 'node:assert/strict';
import { caseTest } from '../../../../tests/testcase.mts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { paramUses } from '../dist/engine/params.js';
import { validate } from '../dist/engine/validate.js';
import { repositoryRoot } from './coverage_case.mjs';
import { isInternalColumnError } from './internal-column-error.mjs';

const plannerRecipe = JSON.parse(await readFile(join(repositoryRoot, 'tests/planner/compile.json'), 'utf8'));
const predicateCaseRecipe = plannerRecipe.cases.find(({ id }) => id === 'planner_column_function_date');
assert.ok(predicateCaseRecipe, 'planner recipe contains a valid date column-function request');
const predicateCase = { input: predicateCaseRecipe.steps[0].input, schema: join('tests/planner', predicateCaseRecipe.steps[0].schema) };
const parsed = parseDbspec(await readFile(join(repositoryRoot, predicateCase.schema), 'utf8'), {});
assert.deepEqual(parsed.diagnostics, []);
const { manifest } = dbspecManifest([parsed.document]);
const model = registerModel(manifest.manifestText, manifest.manifestHash);

const selectedRequest = () => ({
  ir_version: 1,
  manifest_hash: manifest.manifestHash,
  kind: 'all',
  n_params: 0,
  entity: 'author',
  columns: { mode: 'none', fn: { selected_year: { column: 'start_dt', fn: { name: 'year' } } } },
});

caseTest('planner rejects missing post-validation predicate field and preserves public code', () => {
  const valid = { ...structuredClone(predicateCase.input), manifest_hash: manifest.manifestHash };
  validate(model, valid);
  assert.equal(paramUses(model, valid)[0][0].type, 'date', 'date column function retains its parameter type');
  for (const dialect of ['mysql', 'postgres', 'sqlite']) new Engine(model, dialect).planner.compile(valid);
  const publicInvalid = structuredClone(valid);
  publicInvalid.where.items[0].pred.column = 'missing_column';
  assert.throws(() => validate(model, publicInvalid), error => error?.code === 'COLUMN_UNKNOWN');
  valid.where.items[0].pred.column = 'missing_column';
  for (const dialect of ['mysql', 'postgres', 'sqlite']) {
    assert.throws(() => new Engine(model, dialect).planner.compile(valid), error => isInternalColumnError(error, 'author', 'missing_column'));
  }
});

caseTest('parameter-use collection rejects missing post-validation function field', () => {
  const valid = { ...structuredClone(predicateCase.input), manifest_hash: manifest.manifestHash };
  validate(model, valid);
  valid.where.items[0].pred.column = 'missing_column';
  assert.throws(() => paramUses(model, valid), error => isInternalColumnError(error, 'author', 'missing_column'));
});

caseTest('planner output projection rejects missing post-validation function field', () => {
  const valid = selectedRequest();
  validate(model, valid);
  const plan = new Engine(model, 'sqlite').planner.compile(valid);
  assert.equal(plan.steps[0].assemble.columns.find(({ name }) => name === 'selected_year')?.type, 'i64');
  valid.columns.fn.selected_year.column = 'missing_column';
  assert.throws(() => new Engine(model, 'sqlite').planner.compile(valid), error => isInternalColumnError(error, 'author', 'missing_column'));
});
