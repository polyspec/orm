import { spawn } from 'node:child_process';
import path from 'node:path';
import { root } from './lib.mjs';
import { PROCESS, runCase, stepLines } from '../../tests/testcase.mjs';

// BUILD_DEADLINE은 문서 build case의 기한이다. prepare가 Mermaid 그림을 browser로 렌더링하고
// vitepress가 모든 page를 build한다. 두 process는 함께 약 10초 걸린다.
const BUILD_DEADLINE = PROCESS;

// command는 node process 하나를 실행하고 그 출력 줄을 case의 단계로 내보낸다.
function command(args, step, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, signal });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      if (code === 0) resolve();
      else reject(new Error(`${args.join(' ')} exited with ${code}`));
    });
  });
}

const passed = await runCase('docs-build', BUILD_DEADLINE, async ({ signal, step }) => {
  for (const args of [
    ['scripts/docs/prepare.mjs'],
    [path.join(root, 'node_modules/vitepress/bin/vitepress.js'), 'build', 'docs'],
  ]) {
    step(`node ${path.relative(root, args[0])}${args.length > 1 ? ` ${args.slice(1).join(' ')}` : ''}`);
    await command(args, step, signal);
  }
});
if (!passed) process.exit(1);
