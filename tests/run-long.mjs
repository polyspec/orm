// 장기 작업(build, 설치, tsc, go generate, go vet, cargo build, cargo test --no-run, format이나
// lint 같은 도구 실행) 하나를 기한 없이 실행한다. tests/testcase.mjs의 runLong으로 시작
// (`RUN <name> no-deadline`), 명령의 출력 줄(STEP, 경과 시간과 함께), 종료 코드(STEP `exit 0`)와
// 결과(PASS, 또는 종료 코드나 signal을 담은 FAIL)를 출력한다. 느리지만 정상인 작업이 시계 때문에
// 실패하지 않도록 기한도, 출력 없음 기한도 없으며 기한 인자를 받지 않는다. 성공과 실패는 명령의
// 종료 코드와 출력한 오류로 정한다. 명령은 이 process와 같은 process group에서 돌아 terminal의
// interrupt가 함께 닿는다.
//
// Usage: node tests/run-long.mjs <name> [--cwd <dir>] -- <program> [args...]
import { spawn } from 'node:child_process';
import { runLong, stepLines } from './testcase.mjs';

function usage() {
  console.error('usage: node tests/run-long.mjs <name> [--cwd <dir>] -- <program> [args...]');
  process.exit(2);
}

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 1 || separator === args.length - 1) usage();
const [name, ...options] = args.slice(0, separator);
const [program, ...programArgs] = args.slice(separator + 1);
let cwd = process.cwd();
if (options.length === 2 && options[0] === '--cwd') cwd = options[1];
else if (options.length !== 0) usage();

const passed = await runLong(name, ({ step }) => new Promise((resolve, reject) => {
  const child = spawn(program, programArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = stepLines(step);
  child.stdout.on('data', chunk => lines.write(String(chunk)));
  child.stderr.on('data', chunk => lines.write(String(chunk)));
  child.on('error', reject);
  child.on('close', (code, signal) => {
    lines.flush();
    if (code === 0) {
      step('exit 0');
      resolve();
    } else reject(new Error(code === null ? `${program} ended by ${signal}` : `${program} exited with ${code}`));
  });
}));
process.exit(passed ? 0 : 1);
