import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mjs';
import { isolatedEnvironment } from '../../tests/environment.mjs';
import { neededFailures } from './ci-passed.mjs';

const script = fileURLToPath(new URL('./ci-passed.mjs', import.meta.url));
const run = env => spawnSync(process.execPath, [script], { encoding: 'utf8', env: isolatedEnvironment(env) });

// ci-passed case(G5.113-2)는 needs의 모든 job이 success일 때만 통과하고, 실패, 취소, 건너뛴 job과 빈 needs는 그 job과 결과를
// 적고 실패하는지 본다.
caseTest('ci-passed passes only when every needed job succeeded', COMPUTE, () => {
  assert.deepEqual(neededFailures({ test: { result: 'success', outputs: {} }, docs: { result: 'success', outputs: {} } }), []);
  assert.deepEqual(neededFailures({ test: { result: 'failure' }, docs: { result: 'cancelled' }, lint: { result: 'skipped' }, other: {} }), [
    'job test ended with failure', 'job docs ended with cancelled', 'job lint ended with skipped', 'job other ended with no result',
  ]);
  assert.deepEqual(neededFailures({}), ['ci-passed received no needed job; list every other job of ci.yml under needs']);
});

caseTest('make ci-passed exits 0 on success, 1 on a failed job and 2 without CI_NEEDS', PROCESS, () => {
  const passed = run({ CI_NEEDS: JSON.stringify({ test: { result: 'success' }, docs: { result: 'success' } }) });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /ci-passed: every one of 2 needed jobs succeeded/);
  const failed = run({ CI_NEEDS: JSON.stringify({ test: { result: 'failure' }, docs: { result: 'success' } }) });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /::error title=ci-passed::job test ended with failure/);
  const missing = run({ CI_NEEDS: '' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /CI_NEEDS is unset; give the job results/);
});
