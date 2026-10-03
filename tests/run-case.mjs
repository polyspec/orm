// 자기 case를 보고하지 않는 명령(build, format, lint, package 검사)을 case 하나로 실행한다.
// 시작과 기한(RUN), 명령의 출력 줄(STEP, 경과 시간과 함께), 결과(PASS, 또는 종료 상태를
// 담은 FAIL)를 tests/testcase.mjs 형식으로 출력하고, 기한이 지나면 명령의 process group을
// 끝낸다. 자기 case를 보고하는 test runner(go test -v, node --test, cargo test, php test)는
// 이것으로 감싸지 않는다.
//
// Usage: node tests/run-case.mjs <name> <deadline> [--cwd <dir>] -- <program> [args...]
// <deadline>은 초나 분 단위 수다(예: 90s, 30m).
import { spawn } from 'node:child_process';
import { runCase, stepLines } from './testcase.mjs';

function usage() {
  console.error('usage: node tests/run-case.mjs <name> <deadline: <n>s|<n>m> [--cwd <dir>] -- <program> [args...]');
  process.exit(2);
}

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 2 || separator === args.length - 1) usage();
const [name, deadlineText, ...options] = args.slice(0, separator);
const [program, ...programArgs] = args.slice(separator + 1);
const deadlineMatch = /^([0-9]+)(s|m)$/.exec(deadlineText);
if (!deadlineMatch) usage();
const deadline = Number(deadlineMatch[1]) * (deadlineMatch[2] === 'm' ? 60_000 : 1000);
let cwd = process.cwd();
if (options.length === 2 && options[0] === '--cwd') cwd = options[1];
else if (options.length !== 0) usage();

const passed = await runCase(name, deadline, ({ signal, step }) => new Promise((resolve, reject) => {
  // 명령은 자기 process group에서 돌아 기한에 그 하위 process까지 함께 끝난다.
  const child = spawn(program, programArgs, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = stepLines(step);
  child.stdout.on('data', chunk => lines.write(String(chunk)));
  child.stderr.on('data', chunk => lines.write(String(chunk)));
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal.addEventListener('abort', stop, { once: true });
  child.on('error', reject);
  child.on('close', (code, killed) => {
    lines.flush();
    signal.removeEventListener('abort', stop);
    if (signal.aborted) reject(signal.reason);
    else if (code === 0) resolve();
    else reject(new Error(`${program} exited with ${code ?? killed}`));
  });
}));
process.exit(passed ? 0 : 1);
