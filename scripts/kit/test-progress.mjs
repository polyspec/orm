// Test progress: one line when a test starts, a line while it keeps running, and one line when it passes, fails, is skipped
// or runs out of time, each stamped with the elapsed time of the run. Every test runner prints through this module, so all
// suites read the same way.
import { writeFileSync } from 'node:fs';
import { compactSeconds } from './time.mjs';

/**
 * @param {object} options
 * @param {(text: string) => void} options.write receives complete lines
 * @param {number} [options.heartbeatMs] interval of the still-running lines
 * @param {number} [options.timeoutMs] a test running longer is reported to `onTimeout`
 * @param {(id: string) => void} [options.onTimeout] stops the test that ran out of time
 * @param {string} [options.command] the command that a timeout stops, named on the timeout line
 * @param {() => number} [options.now]
 * @param {string} [options.resultFile] receives the counts of the run as JSON when it ends
 */
export function createProgress({ write, heartbeatMs = 5000, timeoutMs, onTimeout, command, now = () => Date.now(), resultFile = process.env.KIT_TEST_RESULT }) {
  const started = now();
  const running = new Map();
  const counts = { passed: 0, failed: 0, skipped: 0, timedOut: 0 };
  const groupCounts = { passed: 0, failed: 0 };
  const line = text => write(`[${compactSeconds(now() - started).padStart(8)}] ${text}\n`);
  const timer = setInterval(() => {
    for (const [id, test] of running) {
      const elapsed = now() - test.started;
      if (timeoutMs !== undefined && elapsed > timeoutMs && !test.expired) {
        test.expired = true;
        counts.timedOut++;
        line(`⏱ ${id} ran ${compactSeconds(elapsed)} and exceeded its ${compactSeconds(timeoutMs)} timeout${command ? `; stopping \`${command}\`` : ''}`);
        onTimeout?.(id);
      } else if (!test.expired) {
        line(`… ${id} still running (${compactSeconds(elapsed)}${timeoutMs === undefined ? '' : ` of ${compactSeconds(timeoutMs)}`})`);
      }
    }
  }, heartbeatMs);
  timer.unref?.();
  // A group (a test file or a package) prints its lines but is not counted as a test.
  const groups = new Map();
  const groupTime = (id, durationMs) => {
    const time = durationMs || now() - groups.get(id);
    groups.delete(id);
    return compactSeconds(time);
  };
  const finish = (id, durationMs) => {
    const test = running.get(id);
    running.delete(id);
    return durationMs ?? (test ? now() - test.started : 0);
  };
  return {
    line,
    start(id, { group = false } = {}) {
      if (group) groups.set(id, now());
      else running.set(id, { started: now(), expired: false });
      line(`▶ ${id}`);
    },
    pass(id, durationMs) {
      if (groups.has(id)) { groupCounts.passed++; return line(`✔ ${id} (${groupTime(id, durationMs)})`); }
      counts.passed++;
      line(`✔ ${id} (${compactSeconds(finish(id, durationMs))})`);
    },
    fail(id, durationMs, message) {
      if (groups.has(id)) { groupCounts.failed++; line(`✖ ${id} (${groupTime(id, durationMs)})`); }
      else {
        counts.failed++;
        line(`✖ ${id} (${compactSeconds(finish(id, durationMs))})`);
      }
      for (const detail of String(message ?? '').split('\n').filter(Boolean)) write(`           ${detail}\n`);
    },
    skip(id) {
      if (groups.has(id)) { groups.delete(id); return line(`○ ${id} skipped`); }
      counts.skipped++;
      finish(id);
      line(`○ ${id} skipped`);
    },
    /**
     * End the run and return `{ passed, failed, skipped, timedOut, ran, ok }`. Tests still running are failures. A failed
     * group, a nonzero `exitCode` of the tool, or a run in which no test passed, failed or ran out of time fails the run
     * even when no test failed: a run that only skipped checked nothing. When no test failed, the summary of a nonzero
     * `exitCode` names the last `errors`, the error lines of the tool, so that it says why the tool exited; it also names
     * the `build` errors, the compiler errors of a package that did not build. The counts go to `resultFile` so that the
     * runner can require that a test ran.
     */
    close(label, { exitCode = 0, errors = [], build = [] } = {}) {
      clearInterval(timer);
      for (const id of [...running.keys()]) this.fail(id, undefined, 'the test did not finish');
      const ran = counts.passed + counts.failed + counts.timedOut;
      const none = ran === 0;
      const failed = counts.failed + counts.timedOut + groupCounts.failed + (exitCode === 0 ? 0 : 1) + (none ? 1 : 0);
      // A group can fail while every test in it passed, for example on a failed hook of a file.
      const groupsFailed = groupCounts.failed === 1 ? ', 1 group failed' : `, ${groupCounts.failed} groups failed`;
      const summary = `${counts.passed} passed, ${counts.failed} failed, ${counts.timedOut} timed out, ${counts.skipped} skipped${groupCounts.failed ? groupsFailed : ''}${none ? ', no test ran' : ''}`;
      const unexplained = counts.failed + counts.timedOut + groupCounts.failed === 0;
      const why = !unexplained ? '' : errors.length ? `: ${errors.slice(-3).join('; ')}` : ' and printed no error line';
      const exit = exitCode === 0 ? '' : `, the tool exited with ${exitCode}${why}`;
      const built = build.length ? `; build errors: ${build.slice(0, 10).join('; ')}${build.length > 10 ? `; and ${build.length - 10} more` : ''}` : '';
      line(`${failed ? '✖' : '✔'} ${label}: ${summary}${exit}${built} (${compactSeconds(now() - started)})`);
      const result = { ...counts, ran, ok: failed === 0 };
      if (resultFile) writeFileSync(resultFile, JSON.stringify(result));
      return result;
    },
    counts,
  };
}
