// The one build of the PHP extension per source and mode (B1-7). php-ext-build calls it with the output path and the mode: it builds
// packages/php-ext once for each key into var/php-ext/build/<key>/, and copies that build to the output, so the sites of one run each
// receive the build without compiling it again.
//
// The key is the SHA-256 of every input that changes the library: the tracked sources of packages/php-ext (src/, config.m4,
// composer.json, testing/native/module.c), the arginfo header and the copy of the SQLite cancel callback (both written by
// php-ext-sources), build.sh (its configure arguments by mode), the output of php-config --version, the mode, the CC and CFLAGS of the
// environment, and the version of the kit builder. A key that is present is never built again.
//
// A build runs under the holder lock of its place (`<key>.lock`, kit's holder-lock), so a second caller of the same key waits for the
// first and then copies its build. A build writes into `<key>.next-<pid>` and is renamed onto `<key>` when it succeeds, so a stopped build
// leaves no place and no half library.
//
// Usage: node scripts/php/php-ext-build.mts <output> <release|native-test>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { waitForHolderLock } from '@polyspec/kit/holder-lock';

const root = path.resolve(import.meta.dirname, '../..');
const extension = 'packages/php-ext';
const library = 'polyspec_orm.so';
const buildRoot = path.join(root, 'var/php-ext/build');

function fail(message: string): never {
  console.error(`php-ext-build: ${message}`);
  process.exit(1);
}

function tracked(paths: readonly string[]): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...paths], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) fail(`git ls-files exited with ${listed.status ?? listed.signal}: ${listed.stderr}`);
  return listed.stdout.split('\0').filter(Boolean).sort();
}

function kitVersion(): string {
  const manifest = createRequire(path.join(root, 'package.json')).resolve('@polyspec/kit/package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

/** The key of the build: a digest of every input named above, each file with its name, so a renamed file changes the key. */
function buildKey(mode: string): string {
  const files = [
    ...tracked([`${extension}/src`, `${extension}/config.m4`, `${extension}/composer.json`, `${extension}/testing/native/module.c`]),
    `${extension}/src/polyspec_orm_arginfo.h`,
    `${extension}/src/native/sqlite_cancel.c`,
    `${extension}/scripts/build.sh`,
  ];
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(`file ${file}\0`);
    digest.update(readFileSync(path.join(root, file)));
    digest.update('\0');
  }
  const php = spawnSync(path.join(root, 'var/tools/bin/php-config'), ['--version'], { encoding: 'utf8' });
  if (php.status !== 0) fail(`php-config --version exited with ${php.status ?? php.signal}; run make install-tools`);
  digest.update(`php-config ${php.stdout.trim()}\0mode ${mode}\0CC ${process.env.CC ?? ''}\0CFLAGS ${process.env.CFLAGS ?? ''}\0kit ${kitVersion()}\0`);
  return digest.digest('hex');
}

function build(place: string, mode: string): void {
  const next = `${place}.next-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  const built = spawnSync('sh', [path.join(root, extension, 'scripts/build.sh'), path.join(next, library), mode], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) {
    rmSync(next, { recursive: true, force: true });
    fail(`build.sh exited with ${built.status ?? built.signal} for mode ${mode}`);
  }
  rmSync(place, { recursive: true, force: true });
  renameSync(next, place);
}

function main(): void {
  const [output, mode] = process.argv.slice(2);
  if (!output || !mode) fail('usage: node scripts/php/php-ext-build.mts <output> <release|native-test>');
  const key = buildKey(mode);
  const place = path.join(buildRoot, key);
  const builtLibrary = path.join(place, library);
  mkdirSync(buildRoot, { recursive: true });
  if (!existsSync(builtLibrary)) {
    const lock = waitForHolderLock(`${place}.lock`, { timeoutMs: Infinity, checkout: root, command: `php-ext-build ${mode}` });
    try {
      if (!existsSync(builtLibrary)) build(place, mode);
    } finally {
      lock.release();
    }
  } else {
    console.log(`[php-ext-build] reuses ${path.relative(root, place)}`);
  }
  const destination = path.resolve(output);
  mkdirSync(path.dirname(destination), { recursive: true });
  const staged = `${destination}.tmp-${process.pid}`;
  copyFileSync(builtLibrary, staged);
  renameSync(staged, destination);
}

main();
