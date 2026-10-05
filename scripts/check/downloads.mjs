// downloads는 check가 읽는 download가 이 checkout에 있는지 network 없이 확인한다. check는 network를 읽지 않는다:
// `make install`이 download하고, 모든 recipe는 cargo, go, npm, Composer를 offline으로 실행한다(Makefile의
// CARGO_NET_OFFLINE, GOPROXY, npm_config_offline, COMPOSER_DISABLE_NETWORK). 그래서 빠진 download는 registry에
// 닿는 실행과 닿지 않는 실행으로 결과가 갈리지 않고 곧바로 실패하며, 이 확인이 그것을 `run make install`과 함께
// 적는다. 결과는 빠진 것마다 { need, message }이고 need는 contracts/check-inputs.json의 needs다(rust, go,
// node-modules, composer).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// CARGO_LOCKS는 check가 build하는 crate의 Cargo.lock이 있는 manifest다.
export const CARGO_MANIFESTS = ['clients/rust/Cargo.toml', 'bench/rust/Cargo.toml', 'tests/interfaces/rust/Cargo.toml', 'clients/php-extension/Cargo.toml'];
// NPM_ROOTS는 npm ci로 설치하는 package directory다.
export const NPM_ROOTS = ['.', 'clients/typescript'];
// COMPOSER_ROOTS는 composer install로 설치하는 package directory다.
export const COMPOSER_ROOTS = ['clients/php'];

const fix = 'run make install, which downloads it';
const offline = { CARGO_NET_OFFLINE: 'true', GOPROXY: 'off', npm_config_offline: 'true', COMPOSER_DISABLE_NETWORK: '1' };

const json = path => JSON.parse(readFileSync(path, 'utf8'));

// npmMissing은 package-lock.json이 설치하는 package(선택적인 platform package는 뺀다) 가운데 node_modules에 없거나
// version이 다른 것이다.
export function npmMissing(root, directory) {
  const lock = join(root, directory, 'package-lock.json');
  const installed = join(root, directory, 'node_modules', '.package-lock.json');
  if (!existsSync(lock)) return [];
  if (!existsSync(installed)) return [`${directory}/node_modules is not installed`];
  const present = json(installed).packages ?? {};
  return Object.entries(json(lock).packages ?? {})
    .filter(([path, entry]) => path && !entry.optional && !entry.link)
    .filter(([path, entry]) => present[path]?.version !== entry.version)
    .map(([path, entry]) => `${directory}/${path} ${entry.version} is ${present[path] ? `installed as ${present[path].version}` : 'not installed'}`);
}

// composerMissing은 composer.lock의 package 가운데 vendor에 없거나 version이 다른 것이다.
export function composerMissing(root, directory) {
  const lock = join(root, directory, 'composer.lock');
  const installed = join(root, directory, 'vendor', 'composer', 'installed.json');
  if (!existsSync(lock)) return [];
  if (!existsSync(installed)) return [`${directory}/vendor is not installed`];
  const present = new Map((json(installed).packages ?? []).map(entry => [entry.name, entry.version]));
  const locked = json(lock);
  return [...(locked.packages ?? []), ...(locked['packages-dev'] ?? [])]
    .filter(entry => present.get(entry.name) !== entry.version)
    .map(entry => `${directory} ${entry.name} ${entry.version} is ${present.has(entry.name) ? `installed as ${present.get(entry.name)}` : 'not installed'}`);
}

// missingDownloads는 빠진 download를 need마다 적는다. run은 spawnSync와 같은 모양이다(test가 바꾼다).
export function missingDownloads(root, { run = spawnSync, env = process.env } = {}) {
  const out = [];
  const tool = (need, what, program, args, cwd = root) => {
    const result = run(program, args, { cwd, encoding: 'utf8', env: { ...env, ...offline, PATH: `${join(homedir(), '.cargo', 'bin')}:${env.PATH ?? ''}` } });
    if (result.status !== 0) {
      const reason = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').find(line => /error|disabled|offline|not found|missing/i.test(line) && !/retry/i.test(line)) ?? `exit ${result.status ?? result.signal ?? result.error?.message}`;
      out.push({ need, message: `${what} are not downloaded (${reason.trim()}); ${fix}` });
    }
  };
  for (const manifest of CARGO_MANIFESTS)
    if (existsSync(join(root, manifest))) tool('rust', `the crates of ${manifest.replace(/Cargo\.toml$/, 'Cargo.lock')}`, 'cargo', ['fetch', '--locked', '--offline', '--manifest-path', manifest]);
  if (existsSync(join(root, 'go.mod'))) tool('go', 'the Go modules of go.mod', 'go', ['mod', 'download']);
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
  // `--need <need>`는 그 need의 download만 본다. 그 밖의 인자는 확인할 checkout이고, 없으면 이 file의 checkout이다.
  const args = process.argv.slice(2);
  const at = args.indexOf('--need');
  const need = at >= 0 ? args.splice(at, 2)[1] : null;
  const root = args[0] ?? new URL('../..', import.meta.url).pathname;
  const missing = missingDownloads(root).filter(entry => !need || entry.need === need);
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
export function offlineMakeErrors(makefile) {
  const errors = OFFLINE.filter(setting => !makefile.split('\n').includes(`export ${setting}`)).map(setting => `Makefile does not export ${setting}`);
  let target = null;
  for (const line of makefile.split('\n')) {
    const rule = /^([\w./%-]+):(?!=)/.exec(line);
    if (rule) target = rule[1];
    if (!line.startsWith('\t') || !target) continue;
    const command = line.trim();
    if (/^install(?:-[\w-]+)?$/.test(target)) continue;
    if (command.includes('$(ONLINE)')) errors.push(`Makefile ${target} runs $(ONLINE) outside an install target: ${command}`);
    else if (DOWNLOAD.test(command)) errors.push(`Makefile ${target} downloads (${command}) outside an install target; make install downloads what the checks read`);
  }
  return errors;
}
