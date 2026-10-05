// JavaScript test와 check runner가 case마다 쓰는 진행 보고 형식과 case별 기한이다
// (internal/testcase의 Go 형식과 같다).
//
//   RUN <case> deadline=<기한>
//   STEP <case> elapsed=<경과>: <단계>
//   PASS <case> elapsed=<경과>
//   FAIL <case> elapsed=<경과>: <이유>
//
// 장기 작업(build, 설치, 도구 실행)은 기한이 없다. runLong은 RUN 줄에 기한 대신 `no-deadline`을
// 쓴다(`RUN <작업> no-deadline`). 그 성공과 실패는 시계가 아니라 관측한 결과와 오류로 정한다.
//
// 기한은 wall-clock 시간이다. 멈춘 case를 끝내는 timer이고 case 자신의 계산 시간을 재는
// 제한이 아니기 때문이다(AGENTS.md testing rule).
import { performance } from 'node:perf_hooks';
import test from 'node:test';

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
export function warning(message) {
  console.log(`WARNING ${message}`);
}

export function duration(ms) {
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

function trim(value) {
  return String(Number(value.toFixed(3)));
}

function reason(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

// runCase는 case 하나를 deadline(ms) 아래에서 실행하고 시작, 결과, 경과 시간을 출력한다.
// body는 { signal, step }을 받는다. signal은 deadline에 abort되고, step(text)은 단계 줄을
// 출력한다. 통과하면 true, 실패하면 false를 돌려준다. process의 종료 코드는 호출자가 정한다.
// deadline에 GRACE를 더한 시간이 지나도 body가 끝나지 않으면 FAIL 줄을 출력하고 process를
// 종료 코드 1로 끝낸다. 멈춘 body가 쥔 timer나 연결 같은 handle은 풀 수 없고, 남겨 두면
// process가 끝나지 않기 때문이다. 같은 process의 뒤 case는 실행되지 않는다.
export async function runCase(name, deadline, body) {
  if (!(deadline > 0)) throw new Error(`runCase ${name}: deadline ${deadline} is not positive`);
  const started = performance.now();
  const elapsed = () => duration(performance.now() - started);
  const controller = new AbortController();
  const step = text => console.log(`STEP ${name} elapsed=${elapsed()}: ${text}`);
  console.log(`RUN ${name} deadline=${duration(deadline)}`);
  const abort = setTimeout(() => controller.abort(new Error(`deadline ${duration(deadline)} exceeded`)), deadline);
  const expire = setTimeout(() => {
    console.log(`FAIL ${name} elapsed=${elapsed()}: deadline ${duration(deadline)} exceeded and the case did not stop`);
    process.exit(1);
  }, deadline + GRACE);
  try {
    await body({ signal: controller.signal, step });
    console.log(`PASS ${name} elapsed=${elapsed()}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${name} elapsed=${elapsed()}: ${reason(error)}`);
    return false;
  } finally {
    clearTimeout(abort);
    clearTimeout(expire);
  }
}

// cases는 test script 하나의 case를 차례로 실행하는 runner다. run(name, deadline, body)은
// runCase로 case 하나를 실행하고 그 결과를 돌려주며, finish()는 실패한 case가 있으면 그 수를
// 출력하고 종료 코드를 1로 둔다.
export function cases() {
  let failed = 0;
  return {
    async run(name, deadline, body) {
      const passed = await runCase(name, deadline, body);
      if (!passed) failed++;
      return passed;
    },
    finish() {
      if (failed > 0) {
        console.log(`${failed} case(s) failed`);
        process.exitCode = 1;
      }
      return failed;
    },
  };
}

// sections는 함수로 나뉘지 않은 test 코드 구역을 case로 보고한다. begin(name, deadline)이
// RUN 줄을 출력하고, end(reason)이 reason이 없으면 PASS, 있으면 FAIL 줄을 출력한다. 구역은
// 끊을 수 없는 코드이므로 deadline에 GRACE를 더한 시간이 지나면 FAIL 줄을 출력하고 process를
// 끝낸다. 구역이 열린 채 process가 끝나면(잡히지 않은 error, 오류를 적고 부른 process.exit) FAIL 줄을 출력한다.
// 그 이유는 구역이 열려 있는 동안의 마지막 오류다: 잡히지 않은 error의 message, 없으면 stderr에 쓴 마지막 줄이다.
// 그래서 FAIL 줄과 그것을 첫 실패 줄로 삼는 보고서가 실제 오류를 담는다.
export function sections() {
  let open = null;
  let lastError = '';
  const elapsed = () => duration(performance.now() - open.started);
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    if (open) {
      const line = String(chunk).split('\n').map(text => text.trim()).filter(Boolean).at(-1);
      if (line) lastError = line;
    }
    return write(chunk, ...rest);
  };
  process.on('uncaughtExceptionMonitor', error => {
    if (open) lastError = String(error?.message ?? error).split('\n')[0];
  });
  process.on('exit', () => {
    if (open) console.log(`FAIL ${open.name} elapsed=${elapsed()}: the process ended inside the case: ${lastError || 'no error was written'}`);
  });
  return {
    begin(name, deadline) {
      if (open) throw new Error(`case ${name} began inside case ${open.name}`);
      if (!(deadline > 0)) throw new Error(`case ${name}: deadline ${deadline} is not positive`);
      open = { name, started: performance.now() };
      console.log(`RUN ${name} deadline=${duration(deadline)}`);
      open.timer = setTimeout(() => {
        console.log(`FAIL ${name} elapsed=${elapsed()}: deadline ${duration(deadline)} exceeded`);
        open = null;
        process.exit(1);
      }, deadline + GRACE);
    },
    step(text) {
      console.log(`STEP ${open.name} elapsed=${elapsed()}: ${text}`);
    },
    end(failure) {
      if (!open) throw new Error('case ended without a beginning');
      clearTimeout(open.timer);
      if (failure) console.log(`FAIL ${open.name} elapsed=${elapsed()}: ${failure}`);
      else console.log(`PASS ${open.name} elapsed=${elapsed()}`);
      open = null;
    },
  };
}

// runGroup은 저마다 기한을 가진 case를 묶은 일 하나(다른 runner를 실행하는 명령)를 실행하고
// "RUN <group> group", 결과와 경과 시간을 출력한다. 묶음 자신은 기한이 없다. body는
// { step }을 받는다. 통과하면 true, 실패하면 false를 돌려준다.
export function runGroup(name, body) {
  return runWithoutDeadline(name, 'group', body);
}

// runLong은 장기 작업 하나(build, 설치, 도구 실행)를 기한 없이 실행하고 "RUN <name> no-deadline",
// 단계 줄, 결과와 경과 시간을 출력한다. 느리지만 정상인 작업이 시계 때문에 실패하지 않도록 timer를
// 두지 않는다. 진행은 body가 step으로 내보내는 단계 줄(하위 process의 출력 줄)로 관측하고, 성공과
// 실패는 body가 관측한 결과(종료 코드와 오류)로 정한다. body는 { step }을 받는다. 통과하면 true,
// 실패하면 false를 돌려준다.
export function runLong(name, body) {
  return runWithoutDeadline(name, 'no-deadline', body);
}

async function runWithoutDeadline(name, kind, body) {
  const started = performance.now();
  const elapsed = () => duration(performance.now() - started);
  const step = text => console.log(`STEP ${name} elapsed=${elapsed()}: ${text}`);
  console.log(`RUN ${name} ${kind}`);
  try {
    await body({ step });
    console.log(`PASS ${name} elapsed=${elapsed()}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${name} elapsed=${elapsed()}: ${reason(error)}`);
    return false;
  }
}

// stepLines는 하위 process 출력 조각을 받아 빈 줄이 아닌 줄마다 step(line)을 부르는 writer다. flush가
// 줄 끝 없이 남은 출력을 내보낸다.
export function stepLines(step) {
  let partial = '';
  return {
    write(chunk) {
      partial += chunk;
      let index;
      while ((index = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, index).replace(/\r$/, '');
        if (line.trim() !== '') step(line);
        partial = partial.slice(index + 1);
      }
    },
    flush() {
      if (partial.trim() !== '') step(partial);
      partial = '';
    },
  };
}

// caseTest는 node:test의 test 하나를 runCase로 실행한다. 실패한 case는 test도 실패시킨다.
// node:test의 timeout은 runCase가 먼저 보고하도록 deadline에 GRACE의 두 배를 더한다.
export function caseTest(name, deadline, body) {
  test(name, { timeout: deadline + 2 * GRACE }, async () => {
    if (!(await runCase(name, deadline, body))) throw new Error(`${name} failed`);
  });
}
