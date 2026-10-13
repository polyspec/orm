import { spawn } from 'node:child_process';
import path from 'node:path';
import { root } from './lib.mjs';
import { runLong, stepLines } from '../../tests/testcase.mjs';

// 문서 build는 장기 작업이다: vitepress가 모든 page를 build한다. Mermaid 그림은 읽는 이의 browser가
// 그리므로(docs/.vitepress/theme/index.ts) build는 Node만 쓴다. runLong으로 기한 없이 실행하고, 진행은
// process의 출력 줄과 종료 코드로 본다.

// command는 node process 하나를 실행하고 그 출력 줄과 종료 코드를 작업의 단계로 내보낸다.
function command(args, step) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root });
    const lines = stepLines(step);
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      if (code === 0) {
        step('exit 0');
        resolve();
      } else reject(new Error(`${args.join(' ')} exited with ${code}`));
    });
  });
}

const passed = await runLong('docs-build', async ({ step }) => {
  const args = [path.join(root, 'node_modules/vitepress/bin/vitepress.js'), 'build', 'docs'];
  step(`node ${path.relative(root, args[0])} ${args.slice(1).join(' ')}`);
  await command(args, step);
});
if (!passed) process.exit(1);
