import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { withPidFixture } from './test-servers-fixture.mts';

test('removes its temporary root and restores process.kill after success and failure', () => {
  const originalKill = Object.getOwnPropertyDescriptor(process, 'kill');
  assert.ok(originalKill);
  let successRoot = '';
  const result = withPidFixture(({ root, paths }) => {
    successRoot = root;
    assert.equal(paths.root, root);
    assert.ok(existsSync(root));
    process.kill = () => true;
    return paths.dir;
  });
  assert.equal(result.startsWith(successRoot), true);
  assert.equal(existsSync(successRoot), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'kill'), originalKill);

  const expected = new Error('fixture callback failed');
  let failureRoot = '';
  assert.throws(() => withPidFixture(({ root }) => {
    failureRoot = root;
    process.kill = () => { throw new Error('stubbed kill'); };
    throw expected;
  }), error => error === expected);
  assert.equal(existsSync(failureRoot), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'kill'), originalKill);
});
