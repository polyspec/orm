// downloads checks, without the network, that the downloads the check reads are present in this checkout. The check does not read the network:
// `make install` downloads them, and every recipe runs cargo, go, npm, and Composer offline (in the Makefile's
// CARGO_NET_OFFLINE, GOPROXY, npm_config_offline, COMPOSER_DISABLE_NETWORK). So a missing download does not split results between runs that reach the registry and runs that do not;
// it fails at once, and this check records it along with
// `run make install`. The result is { need, message } for each missing item, where need is a needs entry of contracts/check-inputs.json (rust, go,
// node-modules, composer).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readComposer, readComposerPackages, readNpmLock } from '../json/formats.mts';
import { makeTargets } from '../repo/testcases.mts';

// NPM_ROOTS are the package directories installed with npm ci. The repository root also installs packages/ts together as a workspace.
export const NPM_ROOTS = ['.'];
// COMPOSER_ROOTS are the package directories installed with composer install. The repository root's composer.json installs packages/php as a path
// repository.
export const COMPOSER_ROOTS = ['.'];

const fix = 'run make install, which downloads it';
const offline = { CARGO_NET_OFFLINE: 'true', GOPROXY: 'off', npm_config_offline: 'true', COMPOSER_DISABLE_NETWORK: '1' };


// npmMissing returns the packages that package-lock.json installs (optional platform packages excluded) that are either absent from node_modules or
// at a different version.
export function npmMissing(root: string, directory: string) {
  const lock = join(root, directory, 'package-lock.json');
  const installed = join(root, directory, 'node_modules', '.package-lock.json');
  if (!existsSync(lock)) return [];
  if (!existsSync(installed)) return [`${directory}/node_modules is not installed`];
  const present = readNpmLock(installed).packages;
  return Object.entries(readNpmLock(lock).packages)
    .filter(([path, entry]) => path && !entry.optional && !entry.link)
    .filter(([path, entry]) => present[path]?.version !== entry.version)
    .map(([path, entry]) => `${directory}/${path} ${entry.version} is ${present[path] ? `installed as ${present[path].version}` : 'not installed'}`);
}

// composerMissing is the packages in composer.lock that are absent from vendor or have a different version.
// The vendor directory is config.vendor-dir in composer.json, and if absent it is vendor.
export function composerMissing(root: string, directory: string) {
  const lock = join(root, directory, 'composer.lock');
  const manifest = join(root, directory, 'composer.json');
  const vendor = (existsSync(manifest) ? readComposer(manifest).config?.['vendor-dir'] : undefined) ?? 'vendor';
  const installed = join(root, directory, vendor, 'composer', 'installed.json');
  if (!existsSync(lock)) return [];
  if (!existsSync(installed)) return [`${join(directory, vendor)} is not installed`];
  const present = new Map(readComposerPackages(installed).packages.map(entry => [entry.name, entry.version]));
  const locked = readComposerPackages(lock);
  return [...locked.packages, ...(locked['packages-dev'] ?? [])]
    .filter(entry => present.get(entry.name) !== entry.version)
    .map(entry => `${directory} ${entry.name} ${entry.version} is ${present.has(entry.name) ? `installed as ${present.get(entry.name)}` : 'not installed'}`);
}

// missingDownloads lists each missing download per need. run has the same shape as spawnSync (the test changes it).
/** A download the checks read that is missing: the need it serves and why. */
export type Missing = { need: string; message: string };
/** The run of a program that missingDownloads uses: spawnSync, or a stand-in of a test. */
export type ToolRun = (program: string, args: string[], options: { cwd: string; encoding: 'utf8'; env: NodeJS.ProcessEnv }) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error | undefined; stdout?: string; stderr?: string };

export function missingDownloads(root: string, { run = spawnSync, env = process.env }: { run?: ToolRun; env?: NodeJS.ProcessEnv } = {}): Missing[] {
  const out: Missing[] = [];
  const tool = (need: string, what: string, program: string, args: string[], cwd = root) => {
    const result = run(program, args, { cwd, encoding: 'utf8', env: { ...env, ...offline, PATH: `${join(homedir(), '.cargo', 'bin')}:${env.PATH ?? ''}` } });
    if (result.status !== 0) {
      const reason = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').find(line => /error|disabled|offline|not found|missing/i.test(line) && !/retry/i.test(line)) ?? `exit ${result.status ?? result.signal ?? result.error?.message}`;
      out.push({ need, message: `${what} are not downloaded (${reason.trim()}); ${fix}` });
    }
  };
  // The crates of every Cargo.lock are checked by make cargo-downloads-check, a target of the kit.mk of @polyspec/kit.
  tool('rust', 'the crates of every Cargo.lock', 'make', ['--no-print-directory', 'cargo-downloads-check']);
  if (existsSync(join(root, 'go.work'))) tool('go', 'the Go modules of go.work', 'go', ['mod', 'download']);
  for (const directory of NPM_ROOTS) {
    const missing = npmMissing(root, directory);
    if (missing.length) out.push({ need: 'node-modules', message: `the npm packages of ${join(directory, 'package-lock.json')} are not installed: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? `; and ${missing.length - 5} more` : ''}; ${fix}` });
  }
  for (const directory of COMPOSER_ROOTS) {
    const missing = composerMissing(root, directory);
    if (missing.length) out.push({ need: 'composer', message: `the Composer packages of ${join(directory, 'composer.lock')} are not installed: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? `; and ${missing.length - 5} more` : ''}; ${fix}` });
  }
  return out;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  // The argument is the checkout to check; if absent, it is this file's checkout.
  const root = process.argv[2] ?? new URL('../..', import.meta.url).pathname;
  const missing = missingDownloads(root);
  for (const { message } of missing) console.error(`downloads: ${message}`);
  if (missing.length) process.exit(1);
  console.log('downloads: every download of the checks is present');
}

// DOWNLOAD is the command that downloads over the network.
const DOWNLOAD = /\b(?:npm (?:ci|install)|composer (?:install|update|require)|cargo fetch|go (?:mod download|get)|curl|wget|rustup toolchain install)\b/;
// OFFLINE is the offline setting that the Makefile must export.
const OFFLINE = ['CARGO_NET_OFFLINE := true', 'GOPROXY := off', 'npm_config_offline := true', 'COMPOSER_DISABLE_NETWORK := 1'];

// offlineMakeErrors checks whether the Makefile runs check offline: it exports the four offline settings, and the download
// command and $(ONLINE) appear only in the recipes of the install targets (install, install-*).
export function offlineMakeErrors(makefile: string) {
  const errors = OFFLINE.filter(setting => !makefile.split('\n').includes(`export ${setting}`)).map(setting => `Makefile does not export ${setting}`);
  for (const { target, commands } of makeTargets(makefile)) {
    if (/^install(?:-[\w-]+)?$/.test(target)) continue;
    for (const recipe of commands) {
      const command = recipe.trim();
      if (command.includes('$(ONLINE)')) errors.push(`Makefile ${target} runs $(ONLINE) outside an install target: ${command}`);
      else if (DOWNLOAD.test(command)) errors.push(`Makefile ${target} downloads (${command}) outside an install target; make install downloads what the checks read`);
    }
  }
  return errors;
}
