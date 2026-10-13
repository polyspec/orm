#!/usr/bin/env node
// Installs or removes the command `dbspec-fmt` under a declared prefix without a symbolic link, as polyspec/template
// installs template-fmt (its scripts/install-cli.mjs).
//
// install: prepares the npm project <prefix>/lib/.polyspec-dbspec-fmt.next-<pid>, whose package.json depends on the
// language service package and the orm package of this checkout, installs both as copies without bin links, renames
// it to <prefix>/lib/polyspec-dbspec-fmt, and writes the executable script <prefix>/bin/dbspec-fmt through a temporary
// file and a rename; the script runs node with the entry of the copied language service package by its absolute
// path. The orm package depends on @polyspec/ordered-json, which is released on GitHub only, so the project carries
// the override of this repository's package.json for it. A later install replaces both, so a changed build is
// installed again; a failed install removes its prepared directory and keeps the previous install.
// uninstall: removes the project and the script.
//
// Usage: node scripts/install-cli.mjs install|uninstall --prefix <directory>
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ options: { prefix: { type: 'string' } }, allowPositionals: true });
const [action] = positionals;
if (!['install', 'uninstall'].includes(action) || positionals.length !== 1 || !values.prefix || !isAbsolute(values.prefix)) {
  throw new Error('usage: install-cli.mjs install|uninstall --prefix <absolute directory>');
}
const project = join(values.prefix, 'lib', 'polyspec-dbspec-fmt');
const command = join(values.prefix, 'bin', 'dbspec-fmt');
const entry = join(project, 'node_modules', '@polyspec', 'dbspec-language', 'bin', 'dbspec-fmt.mjs');

if (action === 'uninstall') {
  rmSync(command, { force: true });
  rmSync(project, { recursive: true, force: true });
  process.stdout.write(`install-cli: removed ${command} and ${project}\n`);
} else {
  const orderedJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).overrides?.['@polyspec/ordered-json'];
  if (typeof orderedJson !== 'string') throw new Error(`${join(root, 'package.json')} has no override for @polyspec/ordered-json`);
  const next = join(values.prefix, 'lib', `.polyspec-dbspec-fmt.next-${process.pid}`);
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  try {
    const language = join(root, 'packages', 'dbspec-language');
    const orm = join(root, 'packages', 'ts');
    writeFileSync(join(next, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { '@polyspec/dbspec-language': `file:${language}`, '@polyspec/orm': `file:${orm}` },
      overrides: { '@polyspec/orm': `file:${orm}`, '@polyspec/ordered-json': orderedJson },
    }, null, 2)}\n`);
    writeFileSync(join(next, '.npmrc'), 'install-links=true\nbin-links=false\n');
    process.stdout.write(`install-cli: npm install in ${next}\n`);
    const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: next, stdio: 'inherit' });
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
