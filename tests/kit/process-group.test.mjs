// The signals and probes of a process group (scripts/kit/process-group.mjs). On macOS a group whose member is in exit answers
// EPERM while the member is already gone from the process table, and ESRCH once the group has ended. The cases inject kill and
// the clock, so no test signals a real group.
import assert from 'node:assert/strict';
import test from 'node:test';
import { signalGroup, waitGroupEnd } from '../../scripts/kit/process-group.mjs';
import { terminateGroup } from '../../scripts/kit/run-tests.mjs';

/** A kill that fails with each code of `codes` in turn, then succeeds; it records each call. */
function killing(...codes) {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    const code = codes.shift();
    if (code) {
      const error = new Error(`kill ${pid} ${code}`);
      error.code = code;
      throw error;
    }
  };
  return { kill, calls };
}

test('signalGroup signals the group with a negative pid and reports sent when it succeeds', () => {
  const { kill, calls } = killing();
  assert.equal(signalGroup(4321, 'SIGTERM', kill), 'sent');
  assert.deepEqual(calls, [[-4321, 'SIGTERM']]);
});

test('signalGroup reports exiting for EPERM and ended for ESRCH, and both are not errors', () => {
  assert.equal(signalGroup(4321, 'SIGTERM', killing('EPERM').kill), 'exiting');
  assert.equal(signalGroup(4321, 'SIGTERM', killing('ESRCH').kill), 'ended');
});

test('signalGroup rethrows any other errno', () => {
  assert.throws(() => signalGroup(4321, 'SIGTERM', killing('EACCES').kill), (error) => error.code === 'EACCES');
});

test('waitGroupEnd does not resolve while the probe reports EPERM, and resolves at ESRCH', async () => {
  const { kill, calls } = killing('EPERM', 'EPERM', 'ESRCH');
  let slept = 0;
  await waitGroupEnd(4321, { deadlineMs: 10_000, intervalMs: 5, kill, now: () => 0, sleep: async () => { slept += 1; } });
  assert.deepEqual(calls, [[-4321, 0], [-4321, 0], [-4321, 0]]);
  assert.equal(slept, 2, 'the group is probed again after each EPERM and not after ESRCH');
});

test('waitGroupEnd fails past its deadline with the pgid, the last errno and the elapsed time while EPERM persists', async () => {
  let clock = 0;
  const { kill } = killing(...Array(1000).fill('EPERM'));
  await assert.rejects(
    waitGroupEnd(4321, { deadlineMs: 100, intervalMs: 10, kill, now: () => clock, sleep: async (ms) => { clock += ms; } }),
    /process group 4321 has not ended after 100 ms; its last probe failed with EPERM/,
  );
});

test('a timed-out test is terminated through its group, and EPERM from a member in exit is not an error', () => {
  const { kill, calls } = killing('EPERM');
  assert.equal(terminateGroup(4321, kill), 'exiting');
  assert.deepEqual(calls, [[-4321, 'SIGTERM']]);
  assert.equal(terminateGroup(4321, killing('ESRCH').kill), 'ended');
});
