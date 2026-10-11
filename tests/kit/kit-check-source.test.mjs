// Tests of scripts/kit/kit-check.mjs: the repository that holds the source of the vendored files has no lock and passes,
// a consumer of kit without its lock fails with the fix, and the check of a consumer reads its lock.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { check } from '../../scripts/kit/kit-check.mjs';
import { tree } from './tree.mjs';

const REPOSITORY = 'https://github.com/polyspec/kit';
const kitJson = { schema: 1, version: '0.0.12', repository: REPOSITORY, vendored: ['scripts/kit', 'tests/kit'] };

test('the source repository of kit has no lock and its check passes', (t) => {
  const root = tree(t, { 'kit.json': `${JSON.stringify(kitJson, null, 2)}\n` });
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', REPOSITORY], { cwd: root }).status, 0);
  assert.deepEqual(check(root), []);
});

test('a consumer of kit without its lock fails and names the fix', (t) => {
  const root = tree(t, { 'kit.json': `${JSON.stringify(kitJson, null, 2)}\n` });
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'https://example.org/consumer/fixture'], { cwd: root }).status, 0);
  assert.deepEqual(check(root), ['.kit/kit.lock.json: the lock is missing. Fix: make kit-sync KIT_TAG=<tag>']);
});
