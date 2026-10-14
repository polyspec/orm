// Prints the bin directory of the lowest Node release that package.json declares in engines.node (">=x.y.z"), from
// ${ORM_NODE_CACHE:-$HOME/.cache/orm-node}, into which make install-node-min downloads the official build.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readPackage } from '../json/formats.mts';

const root = resolve(import.meta.dirname, '../..');
const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
const version = /^>=(\d+\.\d+\.\d+)$/.exec(readPackage(join(root, 'package.json')).engines?.['node'] ?? '')?.[1]
  ?? fail('package.json declares no engines.node >=x.y.z');
const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : fail(`unsupported OS ${process.platform}`);
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : fail(`unsupported architecture ${process.arch}`);
const cache = process.env['ORM_NODE_CACHE'] || join(homedir(), '.cache/orm-node');
const name = `node-v${version}-${os}-${arch}`;
const node = join(cache, name, 'bin', 'node');
const present = (): boolean => {
  try { accessSync(node, constants.X_OK); return true; } catch { return false; }
};
// Only make install-node-min (ORM_NODE_MIN_INSTALL=1) downloads; a check reads no network, so a missing Node fails
// with the make step that downloads it.
if (!present()) {
  if (process.env['ORM_NODE_MIN_INSTALL'] !== '1') fail(`node-min: Node ${version} is not in ${cache}; run make install, which downloads it`, 1);
  // The archive is unpacked in a temporary directory of the cache and renamed into place when complete, so a broken
  // download leaves no half Node.
  const next = join(cache, `${name}.next-${process.pid}`);
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const response = await fetch(`https://nodejs.org/dist/v${version}/${name}.tar.gz`);
  if (!response.ok) fail(`node-min: https://nodejs.org/dist/v${version}/${name}.tar.gz answered ${response.status}`, 1);
  const archive = join(next, `${name}.tar.gz`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const unpacked = spawnSync('tar', ['-xzf', archive, '-C', next], { stdio: 'inherit' });
  if (unpacked.status !== 0) fail(`node-min: tar could not unpack ${archive}`, 1);
  rmSync(join(cache, name), { recursive: true, force: true });
  renameSync(join(next, name), join(cache, name));
  rmSync(next, { recursive: true, force: true });
}
console.log(join(cache, name, 'bin'));
