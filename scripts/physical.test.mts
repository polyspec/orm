// The shared steps of the physical checks (scripts/physical.mts): run returns the standard output of a process that ends
// with 0, fails with the exit code and the output otherwise, and fails a process that leaves another one in its group.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseTest, PROCESS } from '../tests/testcase.mts';
import { run } from './physical.mts';

caseTest('run returns the output of a process that exits with 0', PROCESS, async () => {
  assert.equal(await run('sh', ['-c', 'printf ok']), 'ok');
});

caseTest('run fails a process that exits with another code and states its output', PROCESS, async () => {
  await assert.rejects(run('sh', ['-c', 'echo broken >&2; exit 3']), /sh exit 3: broken/);
});

caseTest('run fails a process that leaves another process in its group', PROCESS, async () => {
  await assert.rejects(run('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & exit 0']), /sh left 1 processes/);
});

// T390: a process past its deadline is asked to end and is reported when it has ended: it runs its own cleanup first.
// The deadline of the case is long against the start of the program, which sets its handler in its first statement.
caseTest('run asks a process past its deadline to end and waits for its end', PROCESS, async () => {
  const work = mkdtempSync(join(tmpdir(), 'orm-physical-stop-'));
  const marker = join(work, 'cleaned');
  const script = `const { writeFileSync } = require('node:fs'); const server = require('node:net').createServer().listen();
    process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(marker)}, 'cleaned'); server.close(); });`;
  try {
    await assert.rejects(run(process.execPath, ['-e', script], process.env, 2000), /timed out after 2000 ms/);
    assert.equal(readFileSync(marker, 'utf8'), 'cleaned', 'the process ran its cleanup before the run reported it');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
