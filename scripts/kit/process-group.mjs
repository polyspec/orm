// The signals and probes of a process group: kill(-pgid, signal) and kill(-pgid, 0). macOS answers EPERM for a group whose
// member is in exit, although the member is gone from the process table; the group has ended only when the call fails with
// ESRCH. signalGroup returns 'sent' when the call succeeds, 'exiting' for EPERM and 'ended' for ESRCH; any other errno is an
// error. waitGroupEnd probes a group until ESRCH. No event reports the end of a group of processes that are not children of
// this process, so waitGroupEnd polls the group at a fixed interval until its deadline; the poll is the only source of the end.

/** Sends `signal` to the process group `pgid`; `kill` is process.kill by default and is injected by the tests. */
export function signalGroup(pgid, signal, kill = (pid, sig) => process.kill(pid, sig)) {
  try {
    kill(-pgid, signal);
    return 'sent';
  } catch (error) {
    if (error.code === 'ESRCH') return 'ended';
    if (error.code === 'EPERM') return 'exiting';
    throw error;
  }
}

/**
 * Resolves when the group `pgid` has ended (its probe fails with ESRCH). The group is probed at `intervalMs`; when the group has
 * not ended at `deadlineMs`, the error names the pgid, the state of the last probe (EPERM while a member is in exit) and the
 * elapsed time. `now` and `sleep` are injected by the tests.
 */
export async function waitGroupEnd(pgid, {
  deadlineMs,
  intervalMs = 50,
  kill,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const started = now();
  for (;;) {
    const state = signalGroup(pgid, 0, kill);
    if (state === 'ended') return;
    const elapsed = now() - started;
    if (elapsed >= deadlineMs) {
      const last = state === 'exiting' ? 'failed with EPERM' : 'succeeded (the group still exists)';
      throw new Error(`process group ${pgid} has not ended after ${elapsed} ms; its last probe ${last}`);
    }
    await sleep(intervalMs);
  }
}
