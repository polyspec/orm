import { spawn } from 'node:child_process';
import path from 'node:path';
import { root } from './lib.mts';
import { runLong, stepLines, type Step } from '../../tests/testcase.mts';

// 문서 build는 장기 작업이다: vitepress가 모든 page를 build한다. Mermaid 그림은 읽는 이의 browser가
// 그리므로(docs/.vitepress/theme/index.ts) build는 Node만 쓴다. runLong으로 기한 없이 실행하고, 진행은
// process의 출력 줄과 종료 코드로 본다.

// command는 node process 하나를 실행하고 그 출력 줄과 종료 코드를 작업의 단계로 내보낸다.
function command(args: string[], step: Step): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root });
    const lines = stepLines(step);
    child.stdout.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => lines.write(String(chunk)));
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

// The dbs fence (docs/.vitepress/dbs.ts) renders through the dbspec language service, which reads the parser entry of
// @polyspec/orm, so both packages are built before the site. npm itself runs the builds; the build is started by
// `npm run docs:build`, which names npm's own script in npm_execpath.
const npm = process.env.npm_execpath;
if (!npm) throw new Error('scripts/docs/build.mts runs through `npm run docs:build`, which sets npm_execpath');

const passed = await runLong('docs-build', async ({ step }) => {
  for (const build of [['run', 'typescript:build'], ['run', '--workspace', '@polyspec/dbspec-language', 'build']]) {
    step(`npm ${build.join(' ')}`);
    await command([npm, ...build], step);
  }
  const vitepress = path.join(root, 'node_modules/vitepress/bin/vitepress.js');
  const args = [vitepress, 'build', 'docs'];
  step(`node ${path.relative(root, vitepress)} ${args.slice(1).join(' ')}`);
  await command(args, step);
});
if (!passed) process.exit(1);
