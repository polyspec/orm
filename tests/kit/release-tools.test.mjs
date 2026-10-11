// The tools of a release (scripts/kit/release-tools.mjs): the install-tools names that config/release.json needs for its
// packages, consumers and Go modules, and the Rust toolchain that rust-toolchain.toml declares for a git-tag proof. The Rust
// toolchain is installed and checked by the same declaration that make install and check-toolchain read. No test reaches
// a registry: rustup and rustc are stubs on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareRust, toolsFor } from '../../scripts/kit/release-tools.mjs';
import { Stop } from '../../scripts/kit/process.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture/config/release.json');
const stop = (fn, pattern) => assert.throws(fn, error => error instanceof Stop && pattern.test(error.message), String(pattern));

// A checkout with rust-toolchain.toml (when `channel` is given) and stubs of rustup and rustc on PATH. Each rustup call is
// appended to rustup.log with its arguments and working directory; rustc prints the release of the channel.
function rustCheckout(t, { channel = '1.99.0', rustupStatus = 0 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-tools-rust-'));
  const bin = path.join(root, '.stubs');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(bin, { recursive: true });
  // The checkout holds its own copy of scripts/kit, as a consumer does; check-toolchain reads the declarations of its checkout.
  cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/kit'), path.join(root, 'scripts/kit'), { recursive: true });
  if (channel !== null) writeFileSync(path.join(root, 'rust-toolchain.toml'), `[toolchain]\nchannel = "${channel}"\n`);
  writeFileSync(path.join(bin, 'rustup'), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nprocess.exit(${rustupStatus});\n`);
  writeFileSync(path.join(bin, 'rustc'), `#!/bin/sh\necho "rustc ${channel ?? '0.0.0'} (stub 2026-01-01)"\n`);
  for (const name of ['rustup', 'rustc']) chmodSync(path.join(bin, name), 0o755);
  const log = path.join(root, 'rustup.log');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_LOG: log };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  return { root, env, calls, log };
}

// The lines that prepareRust printed, the lines of the errors it wrote, and the stdout of the checks it ran.
function capture() {
  const out = [];
  const err = [];
  return { out, err, print: line => out.push(line), error: line => err.push(line) };
}

test('release-tools derives the install-tools names of the fixture configuration and asks for the Rust toolchain of a git-tag proof', () => {
  const config = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.ok(config.proof?.gitTag, 'the fixture proves a git-tag manifest, so the proof needs its Rust toolchain');
  assert.deepEqual(toolsFor(config), {
    install: ['npm', 'composer', 'python', 'pythonBackend', 'go'],
    rust: true,
  });
});

test('release-tools installs only the tools that a configuration without Go modules or git-tag proofs needs', () => {
  const config = {
    packages: [{ kind: 'composer', directory: 'packages/php', name: 'vendor/php' }],
    manifests: { 'packages/php/composer.json': 'archive' },
    goModules: {},
    consumers: { composer: { directory: 'tests/composer', smoke: { 'vendor/php': ['php', '-v'] } } },
  };
  assert.deepEqual(toolsFor(config), { install: ['composer'], rust: false });
});

test('release-tools installs the Python and its build backend for a wheel package, and npm for an npm package', () => {
  const config = {
    packages: [
      { kind: 'npm', directory: 'packages/js', name: 'js' },
      { kind: 'wheel', directory: 'packages/py', name: 'py' },
    ],
    goModules: {},
  };
  assert.deepEqual(toolsFor(config), { install: ['npm', 'python', 'pythonBackend'], rust: false });
});

test('prepareRust installs the channel of rust-toolchain.toml with rustup in the checkout and checks rustc against it', (t) => {
  const box = rustCheckout(t, { channel: '1.99.0' });
  const io = capture();
  prepareRust(box.root, { env: box.env, ...io });
  // rustup reports the working directory with its symbolic links resolved (/private/var on macOS).
  assert.deepEqual(box.calls(), [{ args: ['toolchain', 'install', '--no-self-update'], cwd: realpathSync(box.root) }]);
  assert.ok(io.out.some(line => line.includes('rust 1.99.0')), `the check of rustc prints the declared release: ${io.out.join('\n')}`);
});

test('prepareRust stops with the file name when a git-tag proof has no rust-toolchain.toml, and calls no rustup', (t) => {
  const box = rustCheckout(t, { channel: null });
  stop(() => prepareRust(box.root, { env: box.env, ...capture() }), /rust-toolchain\.toml is missing; the git-tag proof needs the Rust channel that it declares/);
  assert.deepEqual(box.calls(), []);
});

test('prepareRust stops with the rustup output when the toolchain cannot be installed', (t) => {
  const box = rustCheckout(t, { channel: '1.99.0', rustupStatus: 1 });
  stop(() => prepareRust(box.root, { env: box.env, ...capture() }), /rustup toolchain install --no-self-update exited with 1/);
});
