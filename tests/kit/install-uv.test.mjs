// Tests of the uv of install-tools (scripts/kit/install-uv.mjs): the archive uv-<target>.tar.gz of the declared release is
// downloaded with its sha256 checked, unpacked into var/tools/uv as it is, wrapped by var/tools/bin/uv, which sets the uv state
// under var/tools; a second run installs nothing; a wrong digest or release fails with the names of both. curl is a PATH stub
// that copies the archive of the test, so no test reaches a network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installUv, UV_TARGETS } from '../../scripts/kit/install-uv.mjs';
import { toolchainCheckout } from './toolchain-checkout.mjs';
import { toolchainStubs, uvRelease } from './toolchain-stubs.mjs';

const install = (root, env, ...tools) => spawnSync(process.execPath, ['scripts/kit/install-tools.mjs', ...tools], { cwd: root, env, encoding: 'utf8' });
const config = value => JSON.stringify({ schema: 1, ...value });
const run = (file, env) => spawnSync(file, ['--version'], { encoding: 'utf8', env }).stdout.trim();
const escape = text => text.replaceAll('.', '\\.').replaceAll('/', '\\/').replaceAll('+', '\\+');

test('uv is downloaded with its sha256 checked, unpacked into var/tools/uv, wrapped, and kept by a second run', (t) => {
  const uv = uvRelease(t);
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ uv: uv.declared }) });
  const next = uvRelease(t, '0.12.25');
  const stubs = toolchainStubs(t, { downloads: { [uv.url]: uv.archive, [next.url]: next.archive } });
  const first = install(root, stubs.env, 'uv');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(stubs.calls().filter(line => line.startsWith('curl')).map(line => line.split(' ').at(-1)), [uv.url]);
  assert.equal(run(path.join(root, 'var/tools/bin/uv'), stubs.env), 'uv 0.12.24 (stub 2026-01-01)');
  assert.deepEqual(readdirSync(path.join(root, 'var/tools/uv')), [`uv-${uv.target}`], 'the archive is unpacked as it is, and removed');

  const wrapper = readFileSync(path.join(root, 'var/tools/bin/uv'), 'utf8');
  assert.match(wrapper, /^#!\/bin\/sh\n# uv 0\.12\.24 of this checkout/);
  assert.match(wrapper, new RegExp(`UV_CACHE_DIR='${escape(path.join(root, 'var/tools/uv-cache'))}'`));
  assert.match(wrapper, new RegExp(`UV_PYTHON_INSTALL_DIR='${escape(path.join(root, 'var/tools/uv-python'))}'`));
  assert.match(wrapper, /UV_NO_CONFIG=1/);
  assert.match(wrapper, /UV_PYTHON_DOWNLOADS=manual/);
  assert.match(wrapper, new RegExp(`exec '${escape(path.join(root, 'var/tools/uv', `uv-${uv.target}`, 'uv'))}' "\\$@"\\n$`));
  assert.equal(wrapper.includes(homedir()), false, 'the wrapper names no directory of the home');
  assert.notEqual(statSync(path.join(root, 'var/tools/bin/uv')).mode & 0o111, 0, 'the wrapper is executable');

  const second = install(root, stubs.env, 'uv');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /uv: 0\.12\.24 is installed in var\/tools\/uv/);
  assert.equal(stubs.calls().filter(line => line.startsWith('curl')).length, 1, 'a second run downloads nothing');

  writeFileSync(path.join(root, 'config/toolchain.json'), config({ uv: next.declared }));
  assert.equal(install(root, stubs.env, 'uv').status, 0);
  assert.equal(run(path.join(root, 'var/tools/bin/uv'), stubs.env), 'uv 0.12.25 (stub 2026-01-01)');
});

test('a uv archive with another digest is refused, nothing is installed, and the error names both digests', (t) => {
  const uv = uvRelease(t);
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ uv: { ...uv.declared, sha256: { [uv.key]: '0'.repeat(64) } } }) });
  const result = install(root, toolchainStubs(t, { downloads: { [uv.url]: uv.archive } }).env, 'uv');
  assert.equal(result.status, 1);
  const actual = createHash('sha256').update(readFileSync(uv.archive)).digest('hex');
  assert.match(result.stderr, new RegExp(`${escape(uv.url)} has the sha256 ${actual}; config/toolchain\\.json uv declares ${'0'.repeat(64)} for ${uv.key}`));
  assert.equal(existsSync(path.join(root, 'var/tools/uv')), false);
});

test('uv of another release than its installation prints fails with the expected and the actual release', (t) => {
  const uv = uvRelease(t);
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ uv: uv.declared }) });
  const wrong = install(root, toolchainStubs(t, { downloads: { [uv.url]: uv.archive }, extra: { STUB_UV_SHOWS: '0.12.10' } }).env, 'uv');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /the installation of uv 0\.12\.24 into .* prints 0\.12\.10; expected 0\.12\.24/);
});

test('a platform without a verified archive or without a declared digest fails with the platforms and the fix', (t) => {
  const uv = uvRelease(t);
  const root = toolchainCheckout(t);
  assert.throws(() => installUv({ root, declared: uv.declared, platform: 'win32-x64' }), /no uv archive is verified for win32-x64; the verified platforms are darwin-arm64, darwin-x64, linux-x64, linux-arm64/);
  const other = Object.keys(UV_TARGETS).find(key => key !== uv.key);
  assert.throws(() => installUv({ root, declared: uv.declared, platform: other }), new RegExp(`config/toolchain\\.json uv declares no sha256 for ${other}; declare the digest of uv-${escape(UV_TARGETS[other])}\\.tar\\.gz of the uv release 0\\.12\\.24`));
});

test('uv with a digest of the wrong form is refused with the rule of the declaration', (t) => {
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ uv: { version: '0.12.24', sha256: { 'linux-x64': 'ABC' } } }) });
  const result = install(root, toolchainStubs(t).env, 'uv');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config\/toolchain\.json uv must record the sha256 of linux-x64 as 64 lowercase hexadecimal digits; it records "ABC"/);
});
