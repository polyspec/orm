// Prints the program path of the lowest PHP release that packages/php/composer.json declares in require.php (">=x.y"),
// or that release with --version. The program is php<x.y> on PATH, as the Debian packages install it, or the Homebrew
// php@<x.y> keg; its PHP_MAJOR_VERSION.PHP_MINOR_VERSION must be x.y.
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { readComposer } from '../json/formats.mts';

const root = resolve(import.meta.dirname, '../..');
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const version = /^>=(\d+\.\d+)$/.exec(readComposer(join(root, 'packages/php/composer.json')).require?.['php'] ?? '')?.[1]
  ?? fail('packages/php/composer.json declares no require.php >=x.y');
if (process.argv[2] === '--version') {
  console.log(version);
  process.exit(0);
}
const executable = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
};
// The program on PATH is found as the shell finds it: the first directory of PATH that holds it executable.
const onPath = (process.env['PATH'] ?? '').split(delimiter).map(directory => join(directory, `php${version}`)).find(executable);
const brew = onPath === undefined ? spawnSync('brew', ['--prefix'], { encoding: 'utf8' }) : undefined;
const program = onPath ?? (brew?.status === 0 ? join(brew.stdout.trim(), 'opt', `php@${version}`, 'bin', 'php') : undefined);
if (program === undefined || !executable(program))
  fail(`PHP ${version} is not installed: no php${version} on PATH and no Homebrew php@${version}; install it (Debian php${version}-cli or Homebrew php@${version})`);
const actual = spawnSync(program ?? '', ['-r', 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION;'], { encoding: 'utf8' }).stdout;
if (actual !== version) fail(`${program ?? ''} is PHP ${actual}, not ${version}`);
console.log(program);
