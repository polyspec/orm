import path from 'node:path';
import { root } from './lib.mts';
import { runChild, runLong, type Step } from '../../tests/testcase.mts';

// The docs build is a long task: vitepress builds every page. The Mermaid diagrams are drawn by the reader's browser
// (docs/.vitepress/theme/index.ts), so the build uses only Node. It runs with runLong and no deadline, and its progress is seen from
// the process's output lines and exit code.

// command runs one node process and emits its output lines and exit code as the task's steps.
async function command(args: string[], step: Step): Promise<void> {
  const code = await runChild(process.execPath, args, step, { cwd: root });
  if (code === 0) step('exit 0');
  else throw new Error(`${args.join(' ')} exited with ${code}`);
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
