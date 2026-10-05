// go test를 build와 실행 두 단계로 나눈다. go test는 test를 실행하기 전에 package와 test binary를
// compile하고, 그 compile은 case를 보고하지 않는다. 그래서 먼저 같은 package, build tag와 build flag로
// test를 하나도 실행하지 않는 `go test -run '^$' -count=1`을 장기 작업 `go-build/<packages>`로
// 기한 없이 실행해(runLong: compiler 출력과 종료 코드를 STEP 줄로) build cache를 채우고, 그 뒤 받은
// 인자 그대로 `go test`를 실행한다. 실행 단계의 test는 internal/testcase로 case마다 자기 기한을 가진다.
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

// go는 `go test <args>`를 실행하고 종료 코드(signal로 끝나면 그 이름)를 돌려준다. step이 있으면 출력 줄을
// STEP으로 내보내고, 없으면 출력을 그대로 잇는다. 명령은 이 process의 process group에 남아 terminal의
// interrupt가 함께 닿는다.
function go(args, step) {
  return new Promise((resolve, reject) => {
    const child = spawn('go', ['test', ...args], { stdio: step ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    const lines = step ? stepLines(step) : null;
    child.stdout?.on('data', chunk => lines.write(String(chunk)));
    child.stderr?.on('data', chunk => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      lines?.flush();
      resolve(code ?? signal);
    });
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node tests/go-test.mjs <go test arguments...>');
    process.exit(2);
  }
  const built = await runLong(`go-build/${packages(args)}`, async ({ step }) => {
    const code = await go(buildArguments(args), step);
    if (code !== 0) throw new Error(`go test build exited with ${code}`);
    step('exit 0');
  });
  if (!built) process.exit(1);
  const code = await go(args);
  process.exit(typeof code === 'number' ? code : 1);
}
