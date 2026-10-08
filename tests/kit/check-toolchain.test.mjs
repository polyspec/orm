// Tests of scripts/kit/check-toolchain.mjs: the running tools are compared with the declarations, offline. Version commands
// are stubs on PATH (the Node.js that runs the test is the real one), so a test sets the running version of each tool.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { toolchainMismatches, toolchainVersions } from '../../scripts/kit/check-toolchain.mjs';
import { installCargoAuditStub, installGovulncheckStub } from './checkout.mjs';
import { toolchainCheckout } from './toolchain-checkout.mjs';
import { versionStubs } from './toolchain-stubs.mjs';

const NODE = process.versions.node;
const FILES = {
  '.node-version': `${NODE}\n`,
  'package.json': '{ "packageManager": "npm@12.2.0" }',
  'rust-toolchain.toml': '[toolchain]\nchannel = "1.98.1"\n',
  'go.mod': 'module example.com/fixture\n\ngo 1.27.1\n',
  'pyproject.toml': 'dev = ["ruff==0.16.10"]\n',
  'config/toolchain.json': JSON.stringify({ schema: 1, php: ['8.2', '8.5'], python: '3.14', composer: { version: '2.10.3' }, go: { mod: 'go.mod' }, ruff: { pyproject: 'pyproject.toml' }, cargoAudit: '0.22.2', govulncheck: '1.1.4' }),
};
const OUTPUTS = {
  npm: '12.2.0',
  go: 'go1.27.1',
  rustc: 'rustc 1.98.1 (abcdef123 2026-01-01)',
  php: '8.5.3',
  python3: 'Python 3.14.1',
  composer: 'Composer version 2.10.3 2026-01-01 00:00:00',
  ruff: 'ruff 0.16.10',
};
const check = (root, env, ...tools) => spawnSync(process.execPath, ['scripts/kit/check-toolchain.mjs', ...tools], { cwd: root, env, encoding: 'utf8' });
const setup = (t, outputs = OUTPUTS, files = FILES) => {
  const root = toolchainCheckout(t, files);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  return { root, stubs: versionStubs(t, outputs) };
};

test('every declared tool at its declared version passes, offline, and the run prints the running releases', (t) => {
  const { root, stubs } = setup(t);
  const result = check(root, stubs.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `[check-toolchain] node ${NODE}, npm 12.2.0, go 1.27.1, rust 1.98.1, php 8.5.3, python 3.14.1, composer 2.10.3, ruff 0.16.10, cargoAudit 0.22.2, govulncheck 1.1.4\n[check-toolchain] 10 tools run at the declared versions\n`);
  assert.equal(result.stderr, '');
  assert.deepEqual(stubs.calls().map(line => line.split(' ')[0]).sort(), ['composer', 'go', 'npm', 'php', 'python3', 'ruff', 'rustc', 'composer', 'go', 'npm', 'php', 'python3', 'ruff', 'rustc'].sort(), 'only version commands run, each once for the check and once for the evidence');
});

test('every tool that differs is named with the declaring file, the expected and the running version, and the fix', (t) => {
  const { root, stubs } = setup(t, {
    npm: '12.1.0', go: 'go1.26.0', rustc: 'rustc 1.97.0 (abcdef123 2026-01-01)', php: '8.4.9', python3: 'Python 3.13.2',
    composer: 'Composer version 2.9.0 2026-01-01 00:00:00', ruff: 'ruff 0.15.0',
  });
  const result = check(root, stubs.env);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stderr.trim().split('\n'), [
    '[check-toolchain] npm: 12.1.0 runs here and packageManager of package.json declares 12.2.0; fix: make install-tools, and var/tools/bin first on PATH',
    '[check-toolchain] go: 1.26.0 runs here and go.mod go directive declares 1.27.1; fix: make install-tools, and var/tools/bin first on PATH',
    '[check-toolchain] rust: 1.97.0 runs here and rust-toolchain.toml channel declares 1.98.1; fix: rustup toolchain install --no-self-update, in the checkout',
    '[check-toolchain] php: 8.4.9 runs here and config/toolchain.json php declares 8.2 or 8.5; fix: install PHP 8.2 or 8.5',
    '[check-toolchain] python: 3.13.2 runs here and config/toolchain.json python declares 3.14; fix: install Python 3.14',
    '[check-toolchain] composer: 2.9.0 runs here and config/toolchain.json composer declares 2.10.3; fix: install Composer 2.10.3, or declare its sha256 and run make install-tools, and var/tools/bin first on PATH',
    '[check-toolchain] ruff: 0.15.0 runs here and pyproject.toml ruff pin declares 0.16.10; fix: make install-tools, and var/tools/bin first on PATH',
    '[check-toolchain] 7 of 10 tools differ from the declared versions',
  ]);
});

test('the Node.js, cargo-audit and govulncheck releases are compared exactly', (t) => {
  const { root, stubs } = setup(t, OUTPUTS, { ...FILES, '.node-version': '1.2.3\n', 'config/toolchain.json': JSON.stringify({ schema: 1, cargoAudit: '0.22.3', govulncheck: '1.1.5' }) });
  const result = check(root, stubs.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`node: ${NODE.replaceAll('.', '\\.')} runs here and \\.node-version declares 1\\.2\\.3; fix: install Node\\.js 1\\.2\\.3`));
  assert.match(result.stderr, /cargoAudit: 0\.22\.2 runs here and config\/toolchain\.json cargoAudit declares 0\.22\.3; fix: make install-tools/);
  assert.match(result.stderr, /govulncheck: 1\.1\.4 runs here and config\/toolchain\.json govulncheck declares 1\.1\.5; fix: make install-tools/);
});

test('PHP and Python are compared by minor release: another patch passes, another minor fails', (t) => {
  const { root, stubs } = setup(t, { ...OUTPUTS, php: '8.2.99', python3: 'Python 3.14.0' });
  assert.deepEqual(toolchainMismatches(['php', 'python'], { root, env: { ...stubs.env, STUB_LOG: stubs.env.STUB_LOG } }), []);
  const other = setup(t, { ...OUTPUTS, php: '8.3.0', python3: 'Python 3.15.0' });
  assert.equal(toolchainMismatches(['php', 'python'], { root: other.root, env: other.stubs.env }).length, 2);
});

test('the commands of var/tools/bin run before those of PATH, and the toolchain selection is off', (t) => {
  const { root, stubs } = setup(t, { ...OUTPUTS, npm: '12.0.0', go: 'go1.27.1', rustc: OUTPUTS.rustc });
  mkdirSync(path.join(root, 'var/tools/bin'), { recursive: true });
  writeFileSync(path.join(root, 'var/tools/bin/npm'), '#!/bin/sh\necho 12.2.0\n');
  chmodSync(path.join(root, 'var/tools/bin/npm'), 0o755);
  const result = check(root, stubs.env, 'npm', 'go', 'rust');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(stubs.calls().every(line => !line.startsWith('npm ')), 'the npm of PATH did not run');
  assert.ok(stubs.calls().includes('go env GOVERSION [GOTOOLCHAIN=local RUSTUP_AUTO_INSTALL=0]'), stubs.calls().join('\n'));
  assert.ok(stubs.calls().includes('rustc --version [GOTOOLCHAIN=local RUSTUP_AUTO_INSTALL=0]'));
});

test('a command that is missing or prints no release is a mismatch that names the command and the declared version', (t) => {
  const { root, stubs } = setup(t, { npm: 'twelve', go: 'go1.27.1', composer: null });
  const result = check(root, stubs.env, 'npm', 'composer');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm: no release in the output of `npm --version`: "twelve"; packageManager of package\.json declares 12\.2\.0; fix: make install-tools/);
  assert.match(result.stderr, /composer: `composer --version --no-ansi` failed \(.*\).*; config\/toolchain\.json composer declares 2\.10\.3; fix: install Composer 2\.10\.3, or declare its sha256/);
});

test('the tools to check come from the arguments; an undeclared tool, an unknown tool or no declaration fails', (t) => {
  const { root, stubs } = setup(t);
  const named = check(root, stubs.env, 'npm');
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /^\[check-toolchain\] npm 12\.2\.0\n\[check-toolchain\] 1 tools run/);

  const bare = toolchainCheckout(t, { 'package.json': '{ "packageManager": "npm@12.2.0" }' });
  const undeclared = check(bare, stubs.env, 'go');
  assert.equal(undeclared.status, 1);
  assert.match(undeclared.stderr, /go is not declared; declare it in config\/toolchain\.json or in its file, or leave it out of the tools to check/);
  const unknown = check(bare, stubs.env, 'make');
  assert.match(unknown.stderr, /unknown tool make; the tools are node, npm, go, rust, php, python, composer, ruff, cargoAudit, govulncheck/);

  const nothing = check(toolchainCheckout(t), stubs.env);
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /no toolchain is declared, so nothing is checked/);
});

test('toolchainVersions reports an unreadable tool as unavailable', (t) => {
  const { root, stubs } = setup(t, { npm: '12.2.0', composer: null });
  const versions = toolchainVersions(['npm', 'composer'], { root, env: { ...stubs.env, PATH: stubs.env.PATH } });
  assert.equal(versions.npm, '12.2.0');
  assert.match(versions.composer, /^unavailable: `composer --version --no-ansi` failed/);
});

test('the make target toolchain-check passes the tools to the check', () => {
  const dry = spawnSync('make', ['-n', '--no-print-directory', '-f', 'scripts/kit/kit.mk', 'toolchain-check', 'TOOLS=npm go'], { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '../..'), encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout.trim(), 'node scripts/kit/check-toolchain.mjs npm go');
});
