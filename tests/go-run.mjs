// go run을 build와 실행 두 단계로 나눈다. go run은 program을 실행하기 전에 compile하고, 그 compile은 아무것도
// 출력하지 않는 장기 작업이다. 그래서 먼저 `go build -o <임시 file> <package>`를 장기 작업 `go-build/<name>`
// (runLong, 기한 없음, compiler 출력과 종료 코드를 STEP 줄로)으로 실행하고, 그 program을 받은 인자로 실행한다.
// program의 출력은 그대로 잇고, 종료 코드로 끝난다. 임시 file은 끝에 지운다.
//
// Usage: node tests/go-run.mjs <name> <package> [args...]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLong, stepLines } from './testcase.mjs';

const [name, pkg, ...args] = process.argv.slice(2);
if (!name || !pkg) {
  console.error('usage: node tests/go-run.mjs <name> <package> [args...]');
  process.exit(2);
}
const directory = mkdtempSync(join(tmpdir(), 'orm-go-run-'));
const program = join(directory, name.replaceAll('/', '_'));
try {
  const built = await runLong(`go-build/${name}`, ({ step }) => new Promise((resolve, reject) => {
    const child = spawn('go', ['build', '-o', program, pkg], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      if (code === 0) { step('exit 0'); resolve(); } else reject(new Error(`go build exited with ${code}`));
    });
  }));
  if (!built) process.exitCode = 1;
  else {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(program, args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
