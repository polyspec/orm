// Helpers of the consumer and proof tests: the release sandbox (release-sandbox.mjs) with the archives of its tag built
// and PATH stubs of the tools that install and prove a release. Each stub is a Node script that appends its call to
// .stubs/tools.json and reads its behavior from the same file:
//   npm       `install --package-lock-only` writes a lock that pins every `file:` tarball with an integrity and one
//             registry package; `ci` installs the tarballs of the lock into node_modules
//   composer  `update --no-install` writes a lock of the artifact zips with a shasum; `install` writes vendor/composer/installed.json
//   gh        `release view` lists state.release names; `release download` copies them from the archives of the sandbox
//   python3   `-m venv DIR` writes DIR/bin/python, which answers `-m pip install SPEC` and any other call
//   cargo, go answer from the state
// No test reaches a registry, GitHub or a network.
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as release from '../../scripts/kit/release.mjs';
import * as consumer from '../../scripts/kit/release-consumer.mjs';
import { releaseSandbox } from './release-sandbox.mjs';

// The start of every stub: the state, the call log and a function that saves both and exits.
const PRELUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const stateFile = process.env.STUB_STATE_FILE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
const call = { tool, args, cwd: process.cwd(), env: {} };
for (const name of ['npm_config_offline', 'npm_config_cache', 'COMPOSER_DISABLE_NETWORK', 'COMPOSER_HOME', 'COMPOSER_CACHE_DIR', 'GOFLAGS', 'GOPROXY', 'GOPATH', 'CARGO_TARGET_DIR', 'VIRTUAL_ENV']) call.env[name] = process.env[name] ?? null;
state.calls.push(call);
const finish = (status = 0, message = '') => {
  if (message) console.error(message);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.exit(status);
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const mode = state.modes[tool] ?? '';
`;

const NPM = `${PRELUDE}
if (mode === 'fail') finish(1, 'npm stub: ' + args[0] + ' failed');
const manifest = readJson('package.json');
const tarballs = Object.entries(manifest.dependencies ?? {}).filter(([, spec]) => spec.startsWith('file:'));
const inspect = file => {
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stub-npm-'));
  execFileSync('tar', ['-xzf', file, '-C', folder]);
  return { folder, manifest: readJson(path.join(folder, 'package', 'package.json')) };
};
const drop = folder => fs.rmSync(folder, { recursive: true, force: true });
if (args[0] === 'install' && args.includes('--package-lock-only')) {
  const packages = { '': { name: manifest.name, dependencies: manifest.dependencies } };
  for (const [name, spec] of tarballs) {
    const { folder, manifest: packed } = inspect(spec.slice(5));
    drop(folder);
    packages['node_modules/' + name] = { version: packed.version, resolved: spec, integrity: 'sha512-own-' + name };
  }
  packages['node_modules/semver'] = { version: '7.6.0', resolved: 'https://registry.npmjs.org/semver/-/semver-7.6.0.tgz', integrity: 'sha512-third-party' };
  fs.writeFileSync('package-lock.json', JSON.stringify({ name: manifest.name, lockfileVersion: 3, requires: true, packages }, null, 2));
  finish();
} else if (args[0] === 'ci') {
  if (!fs.existsSync('package-lock.json')) finish(1, 'npm stub: npm ci needs a package-lock.json');
  const lock = readJson('package-lock.json');
  for (const [name, spec] of tarballs) {
    const entry = lock.packages['node_modules/' + name];
    if (!entry || entry.resolved !== spec) finish(1, 'npm stub: the lock does not pin ' + name + ' as ' + spec);
    const { folder } = inspect(spec.slice(5));
    const target = path.join('node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(folder, 'package'), target, { recursive: true });
    if (mode === 'wrong-version') fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ ...readJson(path.join(target, 'package.json')), version: '9.9.9' }));
    drop(folder);
  }
  finish();
} else finish(1, 'npm stub: unexpected arguments ' + JSON.stringify(args));
`;

const COMPOSER = `${PRELUDE}
if (mode === 'fail') finish(1, 'composer stub: ' + args[0] + ' failed');
const manifest = readJson('composer.json');
if (args[0] === 'update' && args.includes('--no-install')) {
  const packages = Object.entries(manifest.require ?? {}).map(([name, version]) => {
    const archive = fs.readdirSync('artifacts').find(file => file.startsWith(name.replace('/', '-') + '-php-'));
    if (!archive) finish(1, 'composer stub: no zip of ' + name + ' in artifacts');
    return { name, version, dist: { type: 'zip', url: 'artifacts/' + archive, shasum: 'sha1-own' } };
  });
  fs.writeFileSync('composer.lock', JSON.stringify({ packages, 'packages-dev': [], 'plugin-api-version': '2.9.0' }, null, 4));
  finish();
} else if (args[0] === 'install') {
  if (!fs.existsSync('composer.lock')) finish(1, 'composer stub: composer install needs a composer.lock');
  const lock = readJson('composer.lock');
  fs.mkdirSync('vendor/composer', { recursive: true });
  const version = mode === 'wrong-version' ? '9.9.9' : null;
  fs.writeFileSync('vendor/composer/installed.json', JSON.stringify({ packages: lock.packages.map(entry => ({ name: entry.name, version: version ?? entry.version })) }));
  finish();
} else finish(1, 'composer stub: unexpected arguments ' + JSON.stringify(args));
`;

const GH = `${PRELUDE}
if (args[0] !== 'release' || mode === 'fail') finish(1, 'gh stub: release ' + args[1] + ' failed');
if (args[1] === 'view') {
  console.log(JSON.stringify({ assets: state.release.names.map(name => ({ name })) }));
  finish();
} else if (args[1] === 'download') {
  const directory = args[args.indexOf('--dir') + 1];
  for (const name of state.release.names) fs.copyFileSync(path.join(state.release.source, name), path.join(directory, name));
  finish();
} else finish(1, 'gh stub: unexpected arguments ' + JSON.stringify(args));
`;

// The interpreter of a virtual environment: it answers pip and the smoke command from the state.
const VENV_PYTHON = `${PRELUDE}
if (args[0] === '-m' && args[1] === 'pip') finish(mode === 'pip-fail' ? 1 : 0, mode === 'pip-fail' ? 'pip stub: no matching distribution' : '');
finish(mode === 'smoke-fail' ? 1 : 0, mode === 'smoke-fail' ? 'python stub: ModuleNotFoundError' : '');
`;

const PYTHON3 = `${PRELUDE}
if (args[0] === '-m' && args[1] === 'venv') {
  const bin = path.join(args[2], 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['python']) fs.writeFileSync(path.join(bin, name), state.venvPython, { mode: 0o755 });
  finish(mode === 'venv-fail' ? 1 : 0, mode === 'venv-fail' ? 'python3 stub: venv failed' : '');
} else finish(1, 'python3 stub: unexpected arguments ' + JSON.stringify(args));
`;

const CARGO = `${PRELUDE}
call.manifest = fs.existsSync('Cargo.toml') ? fs.readFileSync('Cargo.toml', 'utf8') : null;
finish(mode === 'fail' ? 101 : 0, mode === 'fail' ? 'cargo stub: failed to find tag' : '');
`;

const GO = `${PRELUDE}
if (args[0] === 'list' && args[1] === '-m') {
  const [module, version] = args[2].split('@');
  if (mode === 'fail') finish(1, 'go stub: ' + args[2] + ': reading failed');
  console.log(mode === 'other' ? module + ' v9.9.9' : module + ' ' + version);
  finish();
} else finish(1, 'go stub: unexpected arguments ' + JSON.stringify(args));
`;

const STUBS = { npm: NPM, composer: COMPOSER, gh: GH, python3: PYTHON3, cargo: CARGO, go: GO };

/** The sandbox at `version` with its release tags, the archives of the tag in var/release/assets and the stubs of the tools. */
export function consumerSandbox(t, { version = '0.0.1', ...options } = {}) {
  const box = releaseSandbox(t, { version, ...options });
  const tag = box.release(version);
  const ctx = (extra = {}) => release.context(box.root, { env: { ...box.env, GITHUB_REPOSITORY: 'example/kit-fixture' }, ...extra });
  const names = release.assets(ctx(), tag);
  const bin = path.join(box.root, '.stubs/bin');
  const stateFile = path.join(box.root, '.stubs/tools.json');
  for (const [name, source] of Object.entries(STUBS)) {
    writeFileSync(path.join(bin, name), source);
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(stateFile, JSON.stringify({ calls: [], modes: {}, release: { names, source: path.join(box.root, release.ASSETS) }, venvPython: VENV_PYTHON }));
  // The remote of the repository URL is the sandbox itself, so git ls-remote reads real tags.
  const config = JSON.parse(readFileSync(path.join(box.root, 'config/release.json'), 'utf8'));
  const env = {
    ...box.env,
    STUB_STATE_FILE: stateFile,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${box.root}.insteadOf`,
    GIT_CONFIG_VALUE_0: config.repositoryUrl,
    // The offline settings of a build recipe, which the consumer install must not pass on.
    npm_config_offline: 'true',
    COMPOSER_DISABLE_NETWORK: '1',
  };
  const sandbox = {
    ...box,
    released: tag,
    version,
    names,
    env,
    ctx: (extra = {}) => release.context(box.root, { env, ...extra }),
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    /** Sets the stub behavior (`modes`: tool to mode) and the names that the release lists. */
    stub(change) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      writeFileSync(stateFile, JSON.stringify({ ...state, ...change, modes: { ...state.modes, ...change.modes } }));
    },
    calls: (tool) => JSON.parse(readFileSync(stateFile, 'utf8')).calls.filter(call => call.tool === tool),
    /** Writes the manifests and locks of the consumer projects for the tag. */
    lock: () => consumer.lockConsumers(sandbox.ctx(), tag),
    /** Runs a command of the sandbox with the stub environment. */
    exec: (command, args) => spawnSync(command, args, { cwd: box.root, env, encoding: 'utf8' }),
  };
  return sandbox;
}
