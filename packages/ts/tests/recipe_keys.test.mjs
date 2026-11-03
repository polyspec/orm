// The refusal unit test of the TypeScript recipe loader's key check (FCV-2 to FCV-4, T334-3-5-6): each unknown file, case, op or
// step key is refused by name, and a recipe whose keys the table holds is accepted.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { checkKeys } from './recipe_keys.mjs';
import { connectDsn } from './recipe_model.mjs';

// A recipe at a path whose $schema is the recipe schema of this checkout, so the key table beside it is read.
const path = 'contracts/fixtures/model_writes/model_writes.json';
const schema = '../../../scripts/features/schema/recipe.schema.json';
const recipe = ({ file = {}, recipeCase = {}, step = { op: 'dsn.connect', dsn: 'case' } } = {}) =>
  JSON.stringify({ $schema: schema, ...file, cases: [{ id: 'case-under-test', steps: [step], ...recipeCase }] });

caseTest('a recipe whose file, case and step keys the table holds is accepted', COMPUTE, () => {
  assert.doesNotThrow(() => checkKeys(path, recipe()));
});

caseTest('an unknown file key is refused by name', COMPUTE, () => {
  assert.throws(() => checkKeys(path, recipe({ file: { bogus: 1 } })), /unknown key bogus$/);
});

caseTest('an unknown case key is refused by name, with its case', COMPUTE, () => {
  assert.throws(() => checkKeys(path, recipe({ recipeCase: { bogus: 1 } })), /case case-under-test: unknown key bogus$/);
});

caseTest('an unknown op is refused by name, with its step', COMPUTE, () => {
  assert.throws(() => checkKeys(path, recipe({ step: { op: 'no.such.op' } })), /step 0: unknown op no\.such\.op$/);
});

caseTest('a step key that another op holds is refused on the op that does not hold it', COMPUTE, () => {
  assert.throws(() => checkKeys(path, recipe({ step: { op: 'dsn.connect', dsn: 'case', pool_size: 2 } })), /\(dsn\.connect\): unknown key pool_size$/);
});

caseTest('a recipe with no $schema is refused, since it names no key table', COMPUTE, () => {
  assert.throws(() => checkKeys(path, JSON.stringify({ cases: [] })), /no \$schema names the recipe key table/);
});

caseTest('model.connect opens the case database, the socket DSN or the text of its dsn (FCV-4, CFG-10)', COMPUTE, () => {
  const caseDsn = 'mysql://root@127.0.0.1:3306/orm_case_17';
  assert.equal(connectDsn(undefined, 'mysql', caseDsn), caseDsn);
  assert.equal(connectDsn('case', 'mysql', caseDsn), caseDsn);
  assert.equal(connectDsn('sqlite://x', 'sqlite', caseDsn), 'sqlite://x');
  assert.equal(connectDsn('case-socket', 'mysql', caseDsn, '/s/mysql.sock'), 'mysql://root@localhost/orm_case_17?socket=/s/mysql.sock');
  assert.throws(() => connectDsn('case-socket', 'postgres', caseDsn, '/s/mysql.sock'), /needs mysql, not postgres$/);
  assert.throws(() => connectDsn('case-socket', 'mysql', caseDsn, ''), /ORM_TEST_MYSQL_SOCKET is unset/);
});
