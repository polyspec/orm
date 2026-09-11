import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root, dist, files, hash } from './lib.mjs';

async function build() {
  const child = spawnSync(process.execPath, ['scripts/docs/build.mjs'], { cwd: root, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status || 1);
  return Object.fromEntries(await Promise.all((await files(dist, { hidden: true })).map(async file => [path.relative(dist, file), hash(await readFile(file))])));
}

const first = await build();
const second = await build();
const changed = [...new Set([...Object.keys(first), ...Object.keys(second)])].filter(name => first[name] !== second[name]);
if (changed.length) throw new Error(`Non-deterministic static output:\n${changed.join('\n')}`);
console.log(`docs: two builds produced identical bytes in ${Object.keys(first).length} files`);
