// downloads는 check가 읽는 download가 이 checkout에 있는지 network 없이 확인한다. check는 network를 읽지 않는다:
// `make install`이 download하고, 모든 recipe는 cargo, go, npm, Composer를 offline으로 실행한다(Makefile의
// CARGO_NET_OFFLINE, GOPROXY, npm_config_offline, COMPOSER_DISABLE_NETWORK). 그래서 빠진 download는 registry에
// 닿는 실행과 닿지 않는 실행으로 결과가 갈리지 않고 곧바로 실패하며, 이 확인이 그것을 `run make install`과 함께
// 적는다. 결과는 빠진 것마다 { need, message }이고 need는 contracts/check-inputs.json의 needs다(rust, go,
// node-modules, composer).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readComposer, readComposerPackages, readNpmLock } from '../json/formats.mts';
import { makeTargets } from '../repo/testcases.mts';

// NPM_ROOTS는 npm ci로 설치하는 package directory다. 저장소 root는 packages/ts를 workspace로 함께 설치한다.
export const NPM_ROOTS = ['.'];
// COMPOSER_ROOTS는 composer install로 설치하는 package directory다. 저장소 root의 composer.json이 packages/php를 path
// repository로 설치한다.
export const COMPOSER_ROOTS = ['.'];

const fix = 'run make install, which downloads it';
const offline = { CARGO_NET_OFFLINE: 'true', GOPROXY: 'off', npm_config_offline: 'true', COMPOSER_DISABLE_NETWORK: '1' };


// npmMissing은 package-lock.json이 설치하는 package(선택적인 platform package는 뺀다) 가운데 node_modules에 없거나
// version이 다른 것이다.
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

// composerMissing은 composer.lock의 package 가운데 vendor에 없거나 version이 다른 것이다.
// vendor directory는 composer.json의 config.vendor-dir이고, 없으면 vendor다.
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

// missingDownloads는 빠진 download를 need마다 적는다. run은 spawnSync와 같은 모양이다(test가 바꾼다).
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
  // 인자는 확인할 checkout이고, 없으면 이 file의 checkout이다.
  const root = process.argv[2] ?? new URL('../..', import.meta.url).pathname;
  const missing = missingDownloads(root);
  for (const { message } of missing) console.error(`downloads: ${message}`);
  if (missing.length) process.exit(1);
  console.log('downloads: every download of the checks is present');
}

// DOWNLOAD는 network에서 받는 명령이다.
const DOWNLOAD = /\b(?:npm (?:ci|install)|composer (?:install|update|require)|cargo fetch|go (?:mod download|get)|curl|wget|rustup toolchain install)\b/;
// OFFLINE은 Makefile이 export해야 하는 offline 설정이다.
const OFFLINE = ['CARGO_NET_OFFLINE := true', 'GOPROXY := off', 'npm_config_offline := true', 'COMPOSER_DISABLE_NETWORK := 1'];

// offlineMakeErrors는 Makefile이 check를 offline으로 실행하는지 본다: 네 offline 설정을 export하고, download하는
// 명령과 $(ONLINE)은 install target(install, install-*)의 recipe에만 있다.
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
