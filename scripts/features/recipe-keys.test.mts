// The key table of the recipe format is the table that scripts/features/schema/recipe.schema.json makes (recipe-keys.mts), and
// it is per op: a key that another op of the same schema holds is refused on an op that does not hold it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { keyTable, keysFile, schemaFile } from './recipe-keys.mts';

const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
const tracked = JSON.parse(readFileSync(keysFile, 'utf8'));

caseTest('the tracked key table is the one the recipe schema makes', COMPUTE, () => {
  assert.deepEqual(tracked, keyTable(schema));
});

caseTest('every op of the step enum has a key list that holds the op itself', COMPUTE, () => {
  const ops: string[] = schema.$defs.step.properties.op.enum;
  assert.equal(Object.keys(tracked.step).length, ops.length);
  for (const op of ops) assert.ok(tracked.step[op].includes('op'), op);
});

caseTest('a key is refused on an op that does not hold it, though another op does', COMPUTE, () => {
  assert.ok(tracked.step['dsn.connect'].includes('dsn'));
  assert.ok(!tracked.step['model.connect'].includes('dsn'));
  assert.deepEqual(tracked.step['model.connect'], ['as', 'op', 'pool_size']);
});

caseTest('a case and a file hold the keys of their schema definitions', COMPUTE, () => {
  assert.deepEqual(tracked.case, ['id', 'install', 'requirements', 'seed', 'steps']);
  assert.ok(tracked.file.includes('cases'));
  assert.ok(!tracked.file.includes('steps'));
});
