import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root } from './lib.mjs';

for (const args of [
  ['scripts/docs/prepare.mjs'],
  [path.join(root, 'node_modules/vitepress/bin/vitepress.js'), 'build', 'docs'],
]) {
  const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status || 1);
}
