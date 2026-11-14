// Case reporting used by JavaScript tests and the check runner is node:test's output (TAP).
//
//   caseTest and cases.run: node:test cases. Steps are written with t.diagnostic, so they become `# <step>` lines in TAP; the result
//   and failure reason are written by node:test as `ok` or `not ok`. cases.run waits for each registered test before the next run.
//   runCase, runGroup, runLong, sections: written by runners that are not tests. The result is the TAP lines `ok - <case>` or
//   `not ok - <case>` with the reason `# <reason>`, and steps are the subprocess output lines as-is.
//
// No case has a deadline (T473, AGENTS.md testing rule): a case ends when its work ends, and its result is decided by what the work
// observed, never by the clock, because the time that a machine gives a case depends on its load and not on the code under test.
// A wait inside a case waits for its event. A case that does not end is seen in the step lines and in the RUN line of the runner
// that started it, and the person or the runner that runs it stops it with a signal.
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** step writes one step line of the running case. */
export type Step = (text: string) => void;
/** The body of a case. signal is aborted when the process is asked to stop (SIGINT or SIGTERM), so that the case ends its work and its cleanup. */
export type CaseBody = (context: { signal: AbortSignal; step: Step }) => unknown;
/** The body of a group or a long task. */
export type LongBody = (context: { step: Step }) => unknown;

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

// stopped is the signal of every case of the process: it is aborted when the process is asked to stop, and by nothing else.
// The listeners are added on the first case, so a script that runs no case keeps the default handling of the signals. Each
// listener runs once: the first SIGINT or SIGTERM asks the cases to end, and a second one ends the process by its default
// handling, so a case that does not follow its signal is still stopped by the one who stops the run.
let stopped: AbortSignal | undefined;
function stopSignal(): AbortSignal {
  if (stopped !== undefined) return stopped;
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      controller.abort(new Error(`the process was asked to stop by ${name}`));
      // The case ends its work on the signal; the exit status is that of the signal.
      process.exitCode = 128 + (name === 'SIGINT' ? 2 : 15);
    });
  }
  stopped = controller.signal;
  return stopped;
}

// execute runs body and returns the failure reason; it is undefined when body passes.
async function execute(body: CaseBody, step: Step): Promise<string | undefined> {
  try {
    await body({ signal: stopSignal(), step });
    return undefined;
  } catch (error) {
    return reason(error);
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

// runCase runs one case and writes its TAP result line. body receives { signal, step }. signal is
// aborted when the process is asked to stop, and step(text) writes a step line. It returns true when the case passes and false when it fails. The process exit code is
// decided by the caller.
export async function runCase(name: string, body: CaseBody): Promise<boolean> {
  return report(name, await execute(body, text => console.log(text)));
}

function registerCase(name: string, body: CaseBody): Promise<boolean> {
  let passed = true;
  return test(name, async t => {
    const failure = await execute(body, text => t.diagnostic(text));
    if (failure !== undefined) {
      passed = false;
      throw new Error(failure);
    }
  }).then(() => passed);
}

// cases registers each run with node:test in call order and waits for that native test before returning its result. A filtered test
// is a successful skip, not a failure; finish reports body failures after the script has awaited its runs.
export function cases() {
  let failed = 0;
  return {
    async run(name: string, body: CaseBody): Promise<boolean> {
      const passed = await registerCase(name, body);
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

// sections reports test code regions that are not split into functions as cases. begin(name)
// starts a region, and end(reason) writes an `ok` line if there is no reason, or a `not ok` line if there is one. If the process
// exits while the region is open (an uncaught error, or a process.exit called after logging an error), it writes a `Bail out!` line. The reason is that the region's
// last error while it was open is the message of the uncaught error, or otherwise the last line written to stderr. So that line carries the actual error.
export function sections() {
  let open: { name: string } | null = null;
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
    begin(name: string): void {
      if (open) throw new Error(`case ${name} began inside case ${open.name}`);
      open = { name };
    },
    step(text: string): void {
      if (!open) throw new Error('step outside a case');
      console.log(text);
    },
    end(failure?: string): void {
      if (!open) throw new Error('case ended without a beginning');
      report(open.name, failure);
      open = null;
    },
  };
}

// runGroup runs one job that groups cases (a command that runs another runner), and writes a TAP result line. body receives { step }. It returns true when it passes and false when it fails.
export function runGroup(name: string, body: LongBody): Promise<boolean> {
  return runJob(name, body);
}

// runLong runs one long-running job (a build, an install, a tool run) and writes a TAP result line. Progress is observed through the output lines that body emits with step (the output of child processes),
// and success or failure is decided by the result body observes (the exit code and errors). body receives { step }. It returns true when it passes,
// and false when it fails.
export function runLong(name: string, body: LongBody): Promise<boolean> {
  return runJob(name, body);
}

async function runJob(name: string, body: LongBody): Promise<boolean> {
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
// Fails the test with the error it carries.
export function caseTest(name: string, body: CaseBody): void {
  void registerCase(name, body);
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
