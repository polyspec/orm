import assert from 'node:assert/strict';
import { caseTest } from '../../../tests/testcase.mts';
import { checkConditionalEntry } from './conditional-entry.mjs';

caseTest('runs a package import in isolated children with the condition enabled only in the second', 1000, () => {
  const calls = [];
  const result = checkConditionalEntry('@polyspec/orm/testing', 'orm-test', '/package', (program, args, options) => {
    calls.push({ program, args, options });
    return calls.length === 1 ? { status: 1, stderr: 'ERR_PACKAGE_PATH_NOT_EXPORTED' } : { status: 0, stderr: '' };
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['--input-type=module', '-e', 'await import("@polyspec/orm/testing")'],
    ['--conditions=orm-test', '--input-type=module', '-e', 'await import("@polyspec/orm/testing")'],
  ]);
  assert(calls.every(({ program, options }) => program === process.execPath && options.cwd === '/package' && options.encoding === 'utf8'));
  assert(calls.every(({ options }) => !Object.hasOwn(options.env, 'ORM_CHECK_RUN_ID') && !Object.hasOwn(options.env, 'MAKEFLAGS')));
  assert.equal(result.withoutCondition.status, 1);
  assert.equal(result.withCondition.status, 0);
});
