#!/usr/bin/env node
// Installs or removes the command `dbspec-fmt` under a declared prefix without a symbolic link, as polyspec/template
// installs template-fmt (its scripts/install-cli.mts).
//
// install: prepares the npm project <prefix>/lib/.polyspec-dbspec-fmt.next-<pid>, whose package.json depends on the
// language service package and the orm package of this checkout, installs both as copies without bin links, renames
// it to <prefix>/lib/polyspec-dbspec-fmt, and writes the executable script <prefix>/bin/dbspec-fmt through a temporary
// file and a rename; the script runs node with the entry of the copied language service package by its absolute
// path. The orm package depends on @polyspec/ordered-json and @polyspec/json, which are released on GitHub only, so the project
// depends on each by the URL of this repository's override, which allow-remote=root admits. A later install replaces both, so a changed build is
// installed again; a failed install removes its prepared directory and keeps the previous install.
// uninstall: removes the project and the script.
//
// Usage: node scripts/install-cli.mts install|uninstall --prefix <directory>
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readNpmLock, readPackage } from './json/formats.mts';
import type { NpmLockEntry } from './json/formats.mts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ options: { prefix: { type: 'string' } }, allowPositionals: true });
const [action] = positionals;
if (action === undefined || !['install', 'uninstall'].includes(action) || positionals.length !== 1 || !values.prefix || !isAbsolute(values.prefix)) {
  throw new Error('usage: install-cli.mts install|uninstall --prefix <absolute directory>');
}
const project = join(values.prefix, 'lib', 'polyspec-dbspec-fmt');
const command = join(values.prefix, 'bin', 'dbspec-fmt');
const entry = join(project, 'node_modules', '@polyspec', 'dbspec-language', 'bin', 'dbspec-fmt.mjs');

if (action === 'uninstall') {
  rmSync(command, { force: true });
  rmSync(project, { recursive: true, force: true });
  process.stdout.write(`install-cli: removed ${command} and ${project}\n`);
} else {
  // Every package of the root that is released on GitHub only is an override by the URL of its release asset; the project
  // takes each one as a root dependency, so allow-remote=root admits it, and a native package of a platform, an optional
  // dependency of the root, stays optional, so the install skips the packages of the other platforms.
  const manifest = readPackage(join(root, 'package.json'));
  const remote = Object.entries(manifest.overrides ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].startsWith('https://'));
  if (!remote.some(([name]) => name === '@polyspec/ordered-json')) throw new Error(`${join(root, 'package.json')} has no override for @polyspec/ordered-json`);
  // The lock records the os, cpu and libc of each native package of a platform; the project takes only the ones of this
  // host, so no package of another platform is installed (npm takes a tarball URL without its platform check).
  const lock = readNpmLock(join(root, 'package-lock.json'));
  const glibc = process.platform === 'linux' && (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime !== undefined;
  const libc = process.platform !== 'linux' ? undefined : glibc ? 'glibc' : 'musl';
  const fits = (entry: NpmLockEntry | undefined) =>
    (entry?.os === undefined || entry.os.includes(process.platform)) && (entry?.cpu === undefined || entry.cpu.includes(process.arch)) && (entry?.libc === undefined || (libc !== undefined && entry.libc.includes(libc)));
  const optional = Object.fromEntries(remote.filter(([name]) => manifest.optionalDependencies?.[name] !== undefined && fits(lock.packages[`node_modules/${name}`])));
  const required = Object.fromEntries(remote.filter(([name]) => manifest.optionalDependencies?.[name] === undefined));
  const installed = [...Object.entries(required), ...Object.entries(optional)];
  const next = join(values.prefix, 'lib', `.polyspec-dbspec-fmt.next-${process.pid}`);
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  try {
    const language = join(root, 'packages', 'dbspec-language');
    const orm = join(root, 'packages', 'ts');
    writeFileSync(join(next, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { '@polyspec/dbspec-language': `file:${language}`, '@polyspec/orm': `file:${orm}`, ...required },
      optionalDependencies: optional,
      overrides: { '@polyspec/orm': `file:${orm}`, ...required, ...optional },
    }, null, 2)}\n`);
    // npm 12 fetches a URL dependency only where allow-remote admits it: the tarball of @polyspec/ordered-json is a
    // dependency of the project root, so allow-remote=root admits it and nothing deeper (as the release consumers do).
    writeFileSync(join(next, '.npmrc'), 'install-links=true\nbin-links=false\nallow-remote=root\n');
    // Each remote tarball is installed by the resolved URL and integrity that the lock of this repository records for it
    // (HR-80), so npm verifies every one: the lock of the project holds those entries, and npm resolves the rest.
    const locked: Record<string, unknown> = {};
    for (const [name, url] of installed) {
      const entry = lock.packages[`node_modules/${name}`];
      if (entry?.resolved !== url || typeof entry.integrity !== 'string') throw new Error(`${join(root, 'package-lock.json')} records no integrity for ${name} at ${url}; run npm install in the root`);
      locked[`node_modules/${name}`] = { version: entry.version, resolved: entry.resolved, integrity: entry.integrity, ...(entry.optional ? { optional: true } : {}) };
    }
    writeFileSync(join(next, 'package-lock.json'), `${JSON.stringify({ name: 'polyspec-dbspec-fmt', lockfileVersion: 3, requires: true, packages: { '': { dependencies: { '@polyspec/dbspec-language': `file:${language}`, '@polyspec/orm': `file:${orm}`, ...required }, optionalDependencies: optional }, ...locked } }, null, 2)}\n`);
    process.stdout.write(`install-cli: npm install in ${next}\n`);
    const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: next, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`npm install in ${next} exited with ${result.status ?? result.signal}; the previous install is unchanged`);
    for (const built of [entry.replace(project, next), join(next, 'node_modules', '@polyspec', 'dbspec-language', 'dist', 'cli', 'main.js')]) {
      if (!existsSync(built)) throw new Error(`${built} is missing; build the language service package first`);
    }
    // The previous project moves aside and the prepared one takes its name; the script switches to it with a rename.
    const previous = join(values.prefix, 'lib', `.polyspec-dbspec-fmt.previous-${process.pid}`);
    if (existsSync(project)) renameSync(project, previous);
    renameSync(next, project);
    rmSync(previous, { recursive: true, force: true });
  } finally {
    rmSync(next, { recursive: true, force: true });
  }
  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(`${command}.next-${process.pid}`, `#!/bin/sh\nexec node '${entry}' "$@"\n`);
  chmodSync(`${command}.next-${process.pid}`, 0o755);
  renameSync(`${command}.next-${process.pid}`, command);
  process.stdout.write(`install-cli: wrote ${command}, which runs ${entry}\n`);
}
