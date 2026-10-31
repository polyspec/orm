// once.mts <stamp> <tool> <path>... -- <program> [args...]
//
// Runs the program of a generator when the key of its inputs differs from the stamp, and writes the stamp when it succeeds (B3-2).
// The key is the SHA-256 of the tool's version, the program and its arguments, and the path and content of every tracked file under
// each path (git ls-files). A generated output is ignored by git, so it is not an input and does not change the key. A key equal to the
// stamp runs nothing and writes nothing. The stamp is replaced by a rename, so a stopped run leaves the previous stamp, never half of one.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
if (separator < 3 || separator === argv.length - 1) {
  console.error('usage: once.mts <stamp> <tool> <path>... -- <program> [args...]');
  process.exit(2);
}
const [stamp, tool = '', ...paths] = argv.slice(0, separator);
const [program = '', ...args] = argv.slice(separator + 1);
if (stamp === undefined) process.exit(2);

const listed = spawnSync('git', ['ls-files', '-z', '--', ...paths], { encoding: 'utf8' });
if (listed.status !== 0) {
  console.error(`once.mts: git ls-files failed: ${listed.stderr}`);
  process.exit(listed.status ?? 1);
}
const hash = createHash('sha256');
hash.update(JSON.stringify({ tool, program, args }));
for (const path of listed.stdout.split('\0').filter(Boolean).sort()) {
  hash.update(`\0${path}\0`);
  hash.update(readFileSync(path));
}
const key = hash.digest('hex');

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === key) {
  console.log(`once.mts: ${program} is up to date (${stamp}); nothing written`);
  process.exit(0);
}
const status = spawnSync(program, args, { stdio: 'inherit' }).status;
if (status !== 0) process.exit(status ?? 1);
mkdirSync(dirname(stamp), { recursive: true });
const next = `${stamp}.next-${process.pid}`;
writeFileSync(next, `${key}\n`);
renameSync(next, stamp);
