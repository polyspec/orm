// The refusal unit test of the TypeScript recipe loader's key check (FCV-2 to FCV-4, T334-3-5-6): each unknown file, case, op or
// step key is refused by name, and a recipe whose keys the table holds is accepted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkKeys } from './recipe_keys.mjs';

// A recipe at a path whose $schema is the recipe schema of this checkout, so the key table beside it is read.
const path = 'contracts/fixtures/model_writes/model_writes.json';
const schema = '../../../scripts/features/schema/recipe.schema.json';
const recipe = ({ file = {}, recipeCase = {}, step = { op: 'dsn.connect', dsn: 'case' } } = {}) =>
  JSON.stringify({ $schema: schema, ...file, cases: [{ id: 'case-under-test', steps: [step], ...recipeCase }] });

test('a recipe whose file, case and step keys the table holds is accepted', () => {
  assert.doesNotThrow(() => checkKeys(path, recipe()));
});

test('an unknown file key is refused by name', () => {
  assert.throws(() => checkKeys(path, recipe({ file: { bogus: 1 } })), /unknown key bogus$/);
});

test('an unknown case key is refused by name, with its case', () => {
  assert.throws(() => checkKeys(path, recipe({ recipeCase: { bogus: 1 } })), /case case-under-test: unknown key bogus$/);
});

test('an unknown op is refused by name, with its step', () => {
  assert.throws(() => checkKeys(path, recipe({ step: { op: 'no.such.op' } })), /step 0: unknown op no\.such\.op$/);
});

test('a step key that another op holds is refused on the op that does not hold it', () => {
  assert.throws(() => checkKeys(path, recipe({ step: { op: 'dsn.connect', dsn: 'case', pool_size: 2 } })), /\(dsn\.connect\): unknown key pool_size$/);
});

test('a recipe with no $schema is refused, since it names no key table', () => {
  assert.throws(() => checkKeys(path, JSON.stringify({ cases: [] })), /no \$schema names the recipe key table/);
});
