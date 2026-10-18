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

// execute는 body를 deadline(ms) 아래에서 실행하고 실패 이유를 돌려준다. 통과하면 undefined다. deadline에 abort되는
// signal을 body에 주고, deadline에 GRACE를 더한 시간이 지나도 body가 끝나지 않으면 `Bail out!` 줄을 쓰고 process를
// 종료 코드 1로 끝낸다. 멈춘 body가 쥔 timer나 연결 같은 handle은 풀 수 없고, 남겨 두면 process가 끝나지 않기 때문이다.
// 같은 process의 뒤 case는 실행되지 않는다.
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

// report는 case 하나의 TAP 결과 줄을 쓴다. 이유는 `#` 줄로 쓰고, 여러 줄이면 줄마다 `#`를 붙인다.
function report(name: string, failure: string | undefined): boolean {
  if (failure === undefined) {
    console.log(`ok - ${name}`);
    return true;
  }
  console.log(`not ok - ${name}`);
  for (const line of failure.split('\n')) console.log(`# ${line}`);
  return false;
}

// runCase는 case 하나를 deadline(ms) 아래에서 실행하고 TAP 결과 줄을 쓴다. body는 { signal, step }을 받는다. signal은
// deadline에 abort되고, step(text)은 단계 줄을 쓴다. 통과하면 true, 실패하면 false를 돌려준다. process의 종료 코드는
// 호출자가 정한다.
export async function runCase(name: string, deadline: number, body: CaseBody): Promise<boolean> {
  return report(name, await execute(name, deadline, body, text => console.log(text)));
}

// cases는 test script 하나의 case를 차례로 실행하는 runner다. run(name, deadline, body)은
// runCase로 case 하나를 실행하고 그 결과를 돌려주며, finish()는 실패한 case가 있으면 그 수를
// 출력하고 종료 코드를 1로 둔다.
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

// sections는 함수로 나뉘지 않은 test 코드 구역을 case로 보고한다. begin(name, deadline)이
// 구역을 시작하고, end(reason)이 reason이 없으면 `ok`, 있으면 `not ok` 줄을 쓴다. 구역은 끊을 수 없는 코드이므로
// deadline에 GRACE를 더한 시간이 지나면 `Bail out!` 줄을 쓰고 process를 끝낸다. 구역이 열린 채 process가
// 끝나면(잡히지 않은 error, 오류를 적고 부른 process.exit) `Bail out!` 줄을 쓴다. 그 이유는 구역이 열려 있는
// 동안의 마지막 오류다: 잡히지 않은 error의 message, 없으면 stderr에 쓴 마지막 줄이다. 그래서 그 줄이 실제 오류를 담는다.
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

// runGroup은 저마다 기한을 가진 case를 묶은 일 하나(다른 runner를 실행하는 명령)를 실행하고 TAP 결과 줄을 쓴다.
// 묶음 자신은 기한이 없다. body는 { step }을 받는다. 통과하면 true, 실패하면 false를 돌려준다.
export function runGroup(name: string, body: LongBody): Promise<boolean> {
  return runWithoutDeadline(name, body);
}

// runLong은 장기 작업 하나(build, 설치, 도구 실행)를 기한 없이 실행하고 TAP 결과 줄을 쓴다. 느리지만 정상인 작업이
// 시계 때문에 실패하지 않도록 timer를 두지 않는다. 진행은 body가 step으로 내보내는 출력 줄(하위 process의 출력)로
// 관측하고, 성공과 실패는 body가 관측한 결과(종료 코드와 오류)로 정한다. body는 { step }을 받는다. 통과하면 true,
// 실패하면 false를 돌려준다.
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

// stepLines는 하위 process 출력 조각을 받아 빈 줄이 아닌 줄마다 step(line)을 부르는 writer다. flush가
// 줄 끝 없이 남은 출력을 내보낸다.
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

// caseTest는 node:test의 test 하나로 case를 실행한다. 단계는 t.diagnostic(TAP의 `#` 줄)이고, 실패한 case는 이유를
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
