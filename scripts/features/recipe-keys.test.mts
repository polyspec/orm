// The key table of the recipe format is the table that scripts/features/schema/recipe.schema.json makes (recipe-keys.mts), and
// it is per op: a key that another op of the same schema holds is refused on an op that does not hold it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { keyTable, keysFile, readSchema } from './recipe-keys.mts';

const table = keyTable(readSchema());
const tracked: unknown = JSON.parse(readFileSync(keysFile, 'utf8'));

caseTest('the tracked key table is the one the recipe schema makes', COMPUTE, () => {
  assert.deepEqual(tracked, table);
});

caseTest('every op of the step enum has a key list that holds the op itself', COMPUTE, () => {
  const ops = Object.keys(table.step);
  assert.ok(ops.length > 0);
  for (const op of ops) assert.ok(table.step[op]?.includes('op'), op);
});

caseTest('a key is refused on an op that does not hold it, though another op does', COMPUTE, () => {
  assert.ok(table.step['dsn.connect']?.includes('dsn'));
  assert.ok(!table.step['model.connect']?.includes('dsn'));
  assert.deepEqual(table.step['model.connect'], ['as', 'op', 'pool_size']);
});

caseTest('a case and a file hold the keys of their schema definitions', COMPUTE, () => {
  assert.deepEqual(table.case, ['id', 'install', 'only', 'requirements', 'seed', 'steps']);
  assert.ok(table.file.includes('cases'));
  assert.ok(!table.file.includes('steps'));
});
