// Tests of the cargo downloads check: it runs cargo fetch --locked offline for every tracked Cargo.lock, names each lock
// with the first error line of cargo, and downloads only with --fetch. cargo is a stub.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cargoDownloads, FIX } from '../../scripts/kit/check-cargo-downloads.mjs';
import { fixtureCheckout as fixture } from './checkout.mjs';

// A cargo that logs its arguments and fails for a manifest named by MISSING with the error line of cargo.
function cargoStub(root) {
  const bin = path.join(root, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, 'cargo.log');
  writeFileSync(log, '');
  writeFileSync(path.join(bin, 'cargo'), `#!/bin/sh
echo "cargo $*" >> "${log}"
case "$*" in *"$MISSING"*) echo "error: failed to download crate itoa v1.0.15" >&2; echo "help: retry without --offline" >&2; exit 101;; esac
`);
  chmodSync(path.join(bin, 'cargo'), 0o755);
  return { cargo: path.join(bin, 'cargo'), calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

test('every Cargo.lock is fetched offline and the check passes when every crate is downloaded', (t) => {
  const root = fixture(t);
  const stub = cargoStub(root);
  const printed = [];
  const { locks, failures } = cargoDownloads({ root, cargo: stub.cargo, env: { ...process.env, MISSING: 'none' }, print: line => printed.push(line) });
  assert.deepEqual(locks, ['packages/fixture-rust/Cargo.lock']);
  assert.deepEqual(failures, []);
  assert.deepEqual(stub.calls(), ['cargo fetch --locked --offline --manifest-path packages/fixture-rust/Cargo.toml']);
  assert.deepEqual(printed, ['packages/fixture-rust/Cargo.lock: every crate is downloaded']);
});

test('a missing crate fails with the lock and the first error line of cargo, not its retry advice', (t) => {
  const root = fixture(t);
  const stub = cargoStub(root);
  const { failures } = cargoDownloads({ root, cargo: stub.cargo, env: { ...process.env, MISSING: 'fixture-rust' } });
  assert.deepEqual(failures, ['packages/fixture-rust/Cargo.lock: error: failed to download crate itoa v1.0.15']);
  assert.match(FIX, /make cargo-downloads-fetch/);
});

test('--fetch runs cargo without --offline', (t) => {
  const root = fixture(t);
  const stub = cargoStub(root);
  const { failures } = cargoDownloads({ root, fetch: true, cargo: stub.cargo, env: { ...process.env, MISSING: 'none' } });
  assert.deepEqual(failures, []);
  assert.deepEqual(stub.calls(), ['cargo fetch --locked --manifest-path packages/fixture-rust/Cargo.toml']);
});
