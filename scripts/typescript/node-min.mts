// Prints the bin directory of the lowest Node release that package.json declares in engines.node (">=x.y.z"): the install
// of that exact version by mise (`mise where node@<version>`). mise installs the tools of mise.toml at the digests of
// mise.lock (make install-tools), so this script downloads nothing; a missing install fails with the make step that installs it.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readPackage } from '../json/formats.mts';

const root = resolve(import.meta.dirname, '../..');
const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
const version = /^>=(\d+\.\d+\.\d+)$/.exec(readPackage(join(root, 'package.json')).engines?.['node'] ?? '')?.[1]
  ?? fail('package.json declares no engines.node >=x.y.z; set engines.node to ">=x.y.z" of the lowest supported Node');
const mise = join(root, 'var/tools/bin/mise');
const where = (() => {
  try {
    return execFileSync(mise, ['where', `node@${version}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`node-min: mise has no node@${version}; mise.toml must declare node = "${version}" and make install-tools must install it. mise said: ${detail}`, 1);
  }
})();
console.log(join(where, 'bin'));
