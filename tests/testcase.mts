// JavaScript test와 check runner가 쓰는 case 보고는 node:test의 출력(TAP)이다.
//
//   caseTest: node:test의 test다. 단계는 t.diagnostic으로 쓰므로 TAP의 `# <단계>` 줄이 되고, 결과와 실패
//   이유는 node:test가 `ok`나 `not ok`로 쓴다.
//   runCase, runGroup, runLong, sections: test가 아닌 runner가 쓴다. 결과는 TAP 줄 `ok - <case>`나
//   `not ok - <case>`와 그 이유 `# <이유>`이고, 단계는 하위 process의 출력 줄 그대로다.
//
// 기한이 지난 case가 signal을 따르지 않고 멈춰 있으면 TAP이 실행을 끊을 때 쓰는 줄 `Bail out! <case>: ...`를
// 쓰고 process를 종료 코드 1로 끝낸다.
//
// 장기 작업(build, 설치, 도구 실행)은 기한이 없다. runLong은 기한을 두지 않고, 그 성공과 실패는 시계가 아니라
// 관측한 결과와 오류로 정한다.
//
// 기한은 wall-clock 시간이다. 멈춘 case를 끝내는 timer이고 case 자신의 계산 시간을 재는 제한이 아니기 때문이다(AGENTS.md testing rule).
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

// 기한의 등급이다. case는 자기가 하는 일에 맞는 등급을 쓰고, 등급보다 오래 걸리는 일은
// 그 기준을 주석에 밝힌 자기 기한을 쓴다.
// COMPUTE: memory 안의 계산과 repository file 읽기만 하는 case. 가장 큰 것(dbspec stress
// 문서의 parse와 emit)도 몇 초 안에 끝나므로 1분을 넘긴 case는 멈춘 것이다.
export const COMPUTE = 60_000;
// DATABASE: TEST_ENV의 database에 연결해 정해진 수의 statement를 실행하는 case. database를
// 만들고 지우는 일과 공유 server에서 lock을 기다리는 시간까지 2분이면 넉넉하다.
export const DATABASE = 120_000;
// PROCESS: go, php, cargo binary, node 같은 하위 process를 실행하는 case. `go run`은 build
// cache가 비었을 때 compile에 몇 분이 걸린다.
export const PROCESS = 300_000;
// GRACE: 기한이 지난 뒤 case를 실패로 끝내기까지 기다리는 시간이다. signal을 따르는 case는
// 기한에 자기 error로 실패하고 정리를 마칠 수 있다.
export const GRACE = 5_000;

// duration은 ms를 Go time.Duration의 String 형식(1m0s, 1.5s, 12ms)으로 쓴다. 세 언어의
// 보고 줄이 같은 형식을 가진다.
// warning은 성능 측정이 문서의 기준값을 넘었다는 줄 `WARNING <message>`를 쓴다. 성능은 측정하고 보고할 뿐 test를
// 실패시키지 않는다(AGENTS.md): 경고는 실패가 아니다. message는 측정값, 기준값, 기계를 담는다. check runner는 이 줄을
// 실행 기록과 summary에 모으고 GitHub Actions의 `::warning::` annotation으로도 쓴다.
export function warning(message: string): void {
  console.log(`WARNING ${message}`);
}

export function duration(ms: number): string {
  // 반올림한 값으로 단위를 고른다. 999.6ms는 1000ms가 아니라 1s다.
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
// 담은 error로 test를 실패시킨다. node:test의 timeout은 기한이 먼저 끝나도록 deadline에 GRACE의 두 배를 더한다.
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
