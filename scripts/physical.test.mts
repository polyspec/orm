// The shared steps of the physical checks (scripts/physical.mts): run returns the standard output of a process that ends
// with 0, fails with the exit code and the output otherwise, and fails a process that leaves another one in its group.
import assert from 'node:assert/strict';
import { caseTest } from '../tests/testcase.mts';
import { run } from './physical.mts';

caseTest('run returns the output of a process that exits with 0', async () => {
  assert.equal(await run('sh', ['-c', 'printf ok']), 'ok');
});

caseTest('run fails a process that exits with another code and states its output', async () => {
  await assert.rejects(run('sh', ['-c', 'echo broken >&2; exit 3']), /sh exit 3: broken/);
});

caseTest('run fails a process that leaves another process in its group', async () => {
  await assert.rejects(run('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & exit 0']), /sh left 1 processes/);
});
