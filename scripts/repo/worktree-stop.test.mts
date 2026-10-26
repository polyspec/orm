import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { caseTest, COMPUTE } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { stopTargetOf } from '../../node_modules/@polyspec/kit/scripts/kit/land.mts';

const root = resolve(import.meta.dirname, '../..');

function withIsolatedEnvironment<T>(body: () => T): T {
  const env = isolatedEnvironment();
  const saved = Object.fromEntries(Object.entries(process.env));
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return body();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

caseTest('the kit make database reads the ORM Makefile-origin stop target', COMPUTE, () => {
  assert.deepEqual(withIsolatedEnvironment(() => stopTargetOf(root)), ['orm-test-servers-stop']);
  assert.match(readFileSync(join(root, 'Makefile'), 'utf8'), /^WORKTREE_STOP = orm-test-servers-stop$/m);
});
