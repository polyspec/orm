// The refusal unit test of the TypeScript recipe loader's key check (FCV-2 to FCV-4, T334-3-5-6): each unknown file, case, op or
// step key is refused by name, and a recipe whose keys the table holds is accepted.
import assert from 'node:assert/strict';
import { caseTest } from '../../../../tests/testcase.mts';
import { checkKeys } from './recipe_keys.mjs';
import { connectDsn } from './recipe_model.mjs';
import { readStep } from './recipe_reads.mjs';

// A recipe at a path whose $schema is the recipe schema of this checkout, so the key table beside it is read.
const path = 'contracts/fixtures/model_writes/model_writes.json';
const schema = '../../../../scripts/features/schema/recipe.schema.json';
const recipe = ({ file = {}, recipeCase = {}, step = { op: 'dsn.connect', dsn: 'case' } } = {}) =>
  JSON.stringify({ $schema: schema, ...file, cases: [{ id: 'case-under-test', steps: [step], ...recipeCase }] });

caseTest('a recipe whose file, case and step keys the table holds is accepted', () => {
  assert.doesNotThrow(() => checkKeys(path, recipe()));
});

caseTest('an unknown file key is refused by name', () => {
  assert.throws(() => checkKeys(path, recipe({ file: { bogus: 1 } })), /unknown key bogus$/);
});

caseTest('an unknown case key is refused by name, with its case', () => {
  assert.throws(() => checkKeys(path, recipe({ recipeCase: { bogus: 1 } })), /case case-under-test: unknown key bogus$/);
});

caseTest('an unknown op is refused by name, with its step', () => {
  assert.throws(() => checkKeys(path, recipe({ step: { op: 'no.such.op' } })), /step 0: unknown op no\.such\.op$/);
});

caseTest('a step key that another op holds is refused on the op that does not hold it', () => {
  assert.throws(() => checkKeys(path, recipe({ step: { op: 'dsn.connect', dsn: 'case', pool_size: 2 } })), /\(dsn\.connect\): unknown key pool_size$/);
});

caseTest('a recipe with no $schema is refused, since it names no key table', () => {
  assert.throws(() => checkKeys(path, JSON.stringify({ cases: [] })), /no \$schema names the recipe key table/);
});

caseTest('model.connect opens the case database, the socket DSN or the text of its dsn (FCV-4, CFG-10)', () => {
  const caseDsn = 'mysql://root@127.0.0.1:3306/orm_case_17';
  assert.equal(connectDsn(undefined, 'mysql', caseDsn), caseDsn);
  assert.equal(connectDsn('case', 'mysql', caseDsn), caseDsn);
  assert.equal(connectDsn('sqlite://x', 'sqlite', caseDsn), 'sqlite://x');
  assert.equal(connectDsn('case-socket', 'mysql', caseDsn, '/s/mysql.sock'), 'mysql://root@localhost/orm_case_17?socket=/s/mysql.sock');
  assert.throws(() => connectDsn('case-socket', 'postgres', caseDsn, '/s/mysql.sock'), /needs mysql, not postgres$/);
  assert.throws(() => connectDsn('case-socket', 'mysql', caseDsn, ''), /ORM_TEST_MYSQL_SOCKET is unset/);
});

caseTest('a step key that the run does not read fails the step by name, and an annotation does not', () => {
  const reads = readStep({ op: 'dsn.connect', dsn: 'case', reason: 'for the reader', bogus: 1 }, 'none');
  assert.equal(reads.step.dsn, 'case');
  assert.throws(() => reads.check(), /the helper did not read bogus of dsn\.connect$/);
  assert.equal(reads.step.bogus, 1);
  assert.doesNotThrow(() => reads.check());
});

caseTest('an outcome key that the run does not read fails the step by name', () => {
  const reads = readStep({ op: 'dsn.connect', expect: { none: { error: 'X', bogus: 1 } } }, 'none');
  assert.equal(reads.step.expect.none.error, 'X');
  assert.throws(() => reads.check(), /the helper did not read expect\.bogus of dsn\.connect$/);
});
