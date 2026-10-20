// Case reporting used by JavaScript tests and the check runner is node:test's output (TAP).
//
//   caseTest: a node:test test. Steps are written with t.diagnostic, so they become `# <step>` lines in TAP; the result and failure
//   reason are written by node:test as `ok` or `not ok`.
//   runCase, runGroup, runLong, sections: written by runners that are not tests. The result is the TAP lines `ok - <case>` or
//   `not ok - <case>` with the reason `# <reason>`, and steps are the subprocess output lines as-is.
//
// When a case past its deadline is stuck and ignores its signal, write the `Bail out! <case>: ...` line that TAP uses to stop the run,
// and end the process with exit code 1.
//
// Long tasks (build, install, tool runs) have no deadline. runLong sets no deadline; its success and failure are decided not by the clock but
// by the observed result and errors.
//
// Deadlines are wall-clock time, because a deadline is a timer that ends a stuck case, not a limit measuring the case's own computation time (AGENTS.md testing rule).
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** step writes one step line of the running case. */
export type Step = (text: string) => void;
/** The body of a case with a deadline: signal aborts at the deadline. */
export type CaseBody = (context: { signal: AbortSignal; step: Step }) => unknown;
/** The body of a group or a long task, which has no deadline. */
export type LongBody = (context: { step: Step }) => unknown;

// The deadline classes. A case uses the class that fits what it does; work that takes longer than its class
// uses its own deadline, with the basis stated in a comment.
// COMPUTE: cases that only compute in memory and read repository files. The largest one (parsing and emitting the dbspec stress
// document) also finishes within seconds, so a case past one minute is stuck.
export const COMPUTE = 60_000;
// DATABASE: cases that connect to the database of TEST_ENV and run a set number of statements. Two minutes is generous, including
// creating and dropping the database and waiting for locks on the shared server.
export const DATABASE = 120_000;
// PROCESS: cases that run child processes such as go, php, cargo binaries, node. `go run` compile takes minutes when
// the build cache is empty.
export const PROCESS = 300_000;
// GRACE: the time to wait after the deadline passes before failing the case. A case that follows its signal can
// fail on the deadline with its own error and finish its cleanup.
export const GRACE = 5_000;

// duration writes ms in Go time.Duration's String format (1m0s, 1.5s, 12ms). The report lines of the three
// languages share this format.
// warning writes a line `WARNING <message>` when a performance measurement exceeds the document's reference value. Performance is measured and reported, not used to fail a test
// (AGENTS.md): a warning is not a failure. The message carries the measured value, the reference value, and the machine. The check runner collects this line
// into the run record and summary, and also writes it as a GitHub Actions `::warning::` annotation.
export function warning(message: string): void {
  console.log(`WARNING ${message}`);
}

export function duration(ms: number): string {
  // The unit is chosen from the rounded value. 999.6ms is 1s, not 1000ms.
  if (Math.round(ms * 1000) < 1000) return `${Math.round(ms * 1000)}µs`;
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms) / 1000;
  if (totalSeconds < 60) return `${trim(totalSeconds)}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  return `${hours ? `${hours}h` : ''}${minutes}m${trim(seconds)}s`;
}

function trim(value: number): string {
  return String(Number(value.toFixed(3)));
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

// execute runs body under deadline (ms) and returns the failure reason; it is undefined when body passes. A body that is aborted at the deadline
// gives body a signal; if body still has not finished after the deadline plus GRACE, it writes a `Bail out!` line and ends the process
// with exit code 1. A stuck body's handles, such as timers or connections, cannot be released, and leaving them open would keep the process from ending.
// Later cases in the same process do not run.
async function execute(name: string, deadline: number, body: CaseBody, step: Step): Promise<string | undefined> {
  if (!(deadline > 0)) throw new Error(`runCase ${name}: deadline ${deadline} is not positive`);
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(new Error(`deadline ${duration(deadline)} exceeded`)), deadline);
  const expire = setTimeout(() => {
    console.log(`Bail out! ${name}: deadline ${duration(deadline)} exceeded and the case did not stop`);
    process.exit(1);
  }, deadline + GRACE);
  try {
    await body({ signal: controller.signal, step });
    return undefined;
  } catch (error) {
    return reason(error);
  } finally {
    clearTimeout(abort);
    clearTimeout(expire);
  }
}

// report writes one case's TAP result line. The reason is written as `#` lines, with a `#` prefixed to each line when there are several.
function report(name: string, failure: string | undefined): boolean {
  if (failure === undefined) {
    console.log(`ok - ${name}`);
    return true;
  }
  console.log(`not ok - ${name}`);
  for (const line of failure.split('\n')) console.log(`# ${line}`);
  return false;
}

// runCase runs one case under deadline (ms) and writes its TAP result line. body receives { signal, step }. signal is
// aborted at the deadline, and step(text) writes a step line. It returns true when the case passes and false when it fails. The process exit code is
// decided by the caller.
export async function runCase(name: string, deadline: number, body: CaseBody): Promise<boolean> {
  return report(name, await execute(name, deadline, body, text => console.log(text)));
}

// cases is a runner that executes the cases of one test script in order. run(name, deadline, body)
// runs one case with runCase and returns its result, and finish() reports the number of failed cases, if any,
// and sets the exit code to 1.
export function cases() {
  let failed = 0;
  return {
    async run(name: string, deadline: number, body: CaseBody): Promise<boolean> {
      const passed = await runCase(name, deadline, body);
      if (!passed) failed++;
      return passed;
    },
    finish(): number {
      if (failed > 0) {
        console.log(`${failed} case(s) failed`);
        process.exitCode = 1;
      }
      return failed;
    },
  };
}

// sections reports test code regions that are not split into functions as cases. begin(name, deadline)
// starts a region, and end(reason) writes an `ok` line if there is no reason, or a `not ok` line if there is one. Since a region is code that cannot be interrupted,
// if the deadline plus GRACE passes, it writes a `Bail out!` line and ends the process. If the process
// exits while the region is open (an uncaught error, or a process.exit called after logging an error), it writes a `Bail out!` line. The reason is that the region's
// last error while it was open is the message of the uncaught error, or otherwise the last line written to stderr. So that line carries the actual error.
export function sections() {
  let open: { name: string; timer?: NodeJS.Timeout } | null = null;
  let lastError = '';
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (open) {
      const line = String(chunk).split('\n').map(text => text.trim()).filter(Boolean).at(-1);
      if (line) lastError = line;
    }
    return Reflect.apply(write, undefined, [chunk, ...rest]) === true;
  };
  process.on('uncaughtExceptionMonitor', error => {
    if (open) lastError = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  });
  process.on('exit', () => {
    if (open) console.log(`Bail out! ${open.name}: the process ended inside the case: ${lastError || 'no error was written'}`);
  });
  return {
    begin(name: string, deadline: number): void {
      if (open) throw new Error(`case ${name} began inside case ${open.name}`);
      if (!(deadline > 0)) throw new Error(`case ${name}: deadline ${deadline} is not positive`);
      const opened: { name: string; timer?: NodeJS.Timeout } = { name };
      open = opened;
      opened.timer = setTimeout(() => {
        console.log(`Bail out! ${name}: deadline ${duration(deadline)} exceeded`);
        open = null;
        process.exit(1);
      }, deadline + GRACE);
    },
    step(text: string): void {
      if (!open) throw new Error('step outside a case');
      console.log(text);
    },
    end(failure?: string): void {
      if (!open) throw new Error('case ended without a beginning');
      clearTimeout(open.timer);
      report(open.name, failure);
      open = null;
    },
  };
}

// runGroup runs one job that groups cases, each with its own deadline (a command that runs another runner), and writes a TAP result line.
// The group itself has no deadline. body receives { step }. It returns true when it passes and false when it fails.
export function runGroup(name: string, body: LongBody): Promise<boolean> {
  return runWithoutDeadline(name, body);
}

// runLong runs one long-running job (a build, an install, a tool run) with no deadline and writes a TAP result line. So that a slow but healthy job
// does not fail because of the clock, no timer is set. Progress is observed through the output lines that body emits with step (the output of child processes),
// and success or failure is decided by the result body observes (the exit code and errors). body receives { step }. It returns true when it passes,
// and false when it fails.
export function runLong(name: string, body: LongBody): Promise<boolean> {
  return runWithoutDeadline(name, body);
}

async function runWithoutDeadline(name: string, body: LongBody): Promise<boolean> {
  const step: Step = text => console.log(text);
  try {
    await body({ step });
    return report(name, undefined);
  } catch (error) {
    return report(name, reason(error));
  }
}

// stepLines is a writer that takes child process output chunks and calls step(line) for each non-empty line. flush
// emits the output left without a line end.
export function stepLines(step: Step): { write(chunk: string | Uint8Array): void; flush(): void } {
  let partial = '';
  return {
    write(chunk: string | Uint8Array): void {
      partial += String(chunk);
      let index;
      while ((index = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, index).replace(/\r$/, '');
        if (line.trim() !== '') step(line);
        partial = partial.slice(index + 1);
      }
    },
    flush(): void {
      if (partial.trim() !== '') step(partial);
      partial = '';
    },
  };
}

// runChild runs one child process and sends its output to the steps as lines. It resolves with the exit code once the
// process closes and its last line is sent, and rejects when the process cannot start.
export function runChild(command: string, args: readonly string[], step: Step, options: SpawnOptions = {}): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, options);
    const lines = stepLines(step);
    child.stdout?.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      resolve(code);
    });
  });
}

// caseTest runs a case as one node:test test. Steps are t.diagnostic (the `#` lines of TAP), and a failed case reports its reason
// Fails the test with the error it carries. node:test's timeout adds twice GRACE to the deadline so the deadline ends first.
export function caseTest(name: string, deadline: number, body: CaseBody): void {
  test(name, { timeout: deadline + 2 * GRACE }, async t => {
    const failure = await execute(name, deadline, body, text => t.diagnostic(text));
    if (failure !== undefined) throw new Error(failure);
  });
}

/**
 * withTemporaryDirectory runs work with a new directory under the system's temporary directory, named by prefix, and removes
 * the directory when work ends, whether it passes or fails, so a case leaves no temporary entry.
 */
export async function withTemporaryDirectory<T>(prefix: string, work: (directory: string) => T | Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await work(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
