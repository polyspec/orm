// go test를 build와 실행 두 단계로 나눈다. go test는 test를 실행하기 전에 package와 test binary를
// compile하고, 그 compile은 case를 보고하지 않는다. 그래서 먼저 같은 package, build tag와 build flag로
// test를 하나도 실행하지 않는 `go test -run '^$' -count=1`을 장기 작업 `go-build/<packages>`로
// 기한 없이 실행해(runLong: compiler 출력과 종료 코드를 STEP 줄로) build cache를 채우고, 그 뒤 받은
// 인자 그대로 `go test`를 실행한다. 실행 단계의 test는 internal/testcase로 case마다 자기 기한을 가진다.
// 실행 단계는 `go test -json`(test2json)으로 실행하고, 그 event의 Output을 사람이 읽는 출력으로 그대로 잇는다.
// `-run`으로 test를 고른 실행은 실행된 test(`"Action":"run"` event)가 하나도 없으면 실패한다: 이름을 잘못 쓴
// pattern은 아무것도 실행하지 않고도 0으로 끝나므로, 실패로 보지 않으면 아무것도 시험하지 않은 채 통과한다. 수는
// 사람이 읽는 출력이 아니라 test2json의 event로 센다. `-run '^$'`(test를 고르지 않는다고 밝힌 실행)은 세지 않는다.
//
// Usage: node tests/go-test.mjs <go test arguments...>
import { spawn } from 'node:child_process';
import { runLong, stepLines } from './testcase.mjs';

// 실행만 정하는 flag는 build 단계에서 뺀다. 값을 따로 받는 flag는 다음 인자도 뺀다.
const runFlags = new Set(['-v', '-run', '-count', '-timeout', '-fuzz', '-fuzztime', '-bench', '-benchtime', '-json', '-failfast', '-short', '-shuffle', '-parallel', '-cpu']);
const valued = new Set(['-run', '-count', '-timeout', '-fuzz', '-fuzztime', '-bench', '-benchtime', '-shuffle', '-parallel', '-cpu']);

// buildArguments는 go test 인자에서 실행 flag를 뺀 build 단계의 인자다.
export function buildArguments(args) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    const [flag] = args[index].split('=');
    if (runFlags.has(flag)) {
      if (valued.has(flag) && !args[index].includes('=')) index++;
      continue;
    }
    out.push(args[index]);
  }
  return [...out, '-run', '^$', '-count=1'];
}

// packages는 인자 가운데 package pattern(./로 시작)이다. build case의 이름이 된다.
export function packages(args) {
  return args.filter(arg => arg.startsWith('./')).map(arg => arg.slice(2)).join(',') || '.';
}

// selection은 인자의 `-run` pattern이다. 없으면 undefined다.
export function selection(args) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-run') return args[index + 1];
    if (args[index].startsWith('-run=')) return args[index].slice('-run='.length);
  }
  return undefined;
}

// go는 `go test <args>`를 실행하고 종료 코드(signal로 끝나면 그 이름)를 돌려준다. step이 있으면(build 단계) 출력
// 줄을 STEP으로 내보낸다. 없으면(실행 단계) `-json`을 더해 실행하고, test2json event의 Output을 그대로 standard
// output에 잇고, JSON이 아닌 줄(build 오류 같은 것)도 그대로 이으며, `"Action":"run"` event의 수를 runs로 돌려준다.
// 명령은 이 process의 process group에 남아 terminal의 interrupt가 함께 닿는다.
function go(args, step) {
  return new Promise((resolve, reject) => {
    const child = spawn('go', ['test', ...(step ? [] : ['-json']), ...args], { stdio: step ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'] });
    const lines = step ? stepLines(step) : null;
    const events = step ? null : testEvents();
    child.stdout?.on('data', chunk => (lines ?? events).write(String(chunk)));
    child.stderr?.on('data', chunk => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      lines?.flush();
      events?.flush();
      resolve({ code: code ?? signal, runs: events?.runs() ?? 0 });
    });
  });
}

// testEvents는 test2json 출력을 줄마다 읽는다. event의 Output(test 출력과 build 출력)은 standard output으로 잇고, JSON이 아닌 줄은 그대로
// 이으며, Test가 있는 `run` event를 센다.
export function testEvents(write = text => process.stdout.write(text)) {
  let partial = '';
  let runs = 0;
  const line = text => {
    let event;
    try { event = text.startsWith('{') ? JSON.parse(text) : undefined; } catch { event = undefined; }
    if (!event) return write(`${text}\n`);
    if (event.Action === 'run' && event.Test) runs++;
    // output event와 build event(build-output, Go 1.24부터 -json이 build 출력도 event로 낸다)의 Output을 잇는다.
    if (typeof event.Output === 'string') write(event.Output);
  };
  return {
    write(chunk) {
      const all = (partial + chunk).split('\n');
      partial = all.pop();
      for (const text of all) line(text);
    },
    flush() {
      if (partial) line(partial);
      partial = '';
    },
    runs: () => runs,
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node tests/go-test.mjs <go test arguments...>');
    process.exit(2);
  }
  const pattern = selection(args);
  const built = await runLong(`go-build/${packages(args)}`, async ({ step }) => {
    const { code } = await go(buildArguments(args), step);
    if (code !== 0) throw new Error(`go test build exited with ${code}`);
    step('exit 0');
  });
  if (!built) process.exit(1);
  const { code, runs } = await go(args);
  if (code === 0 && pattern !== undefined && pattern !== '^$' && runs === 0) {
    console.error(`go-test: -run ${pattern} selected no test in ${packages(args)}`);
    process.exit(1);
  }
  process.exit(typeof code === 'number' ? code : 1);
}
