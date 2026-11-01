// A leftover source of an interrupted compiler fixture run must not break the next run or stay in the tree (CR25).
// Usage: ORM_RUST_TEST_FEATURES=... CARGO_TARGET_DIR=... node --test scripts/rust/compiler-fixtures.test.mts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const examples = join(root, 'packages/rust/tests/examples');
const runner = join(root, 'scripts/rust/compiler-fixtures.mts');
const toolchain = readFileSync(join(root, 'rust-toolchain.toml'), 'utf8').match(/^channel = "(.*)"$/m)?.[1];
const fixture = 'generated-typed-getter-positive';

test('a stale source of the case is overwritten and the scratch directory is removed', () => {
  assert.ok(toolchain, 'rust-toolchain.toml names a channel');
  assert.ok(process.env.ORM_RUST_TEST_FEATURES && process.env.CARGO_TARGET_DIR, 'the Rust test features and CARGO_TARGET_DIR are set');
  mkdirSync(examples, { recursive: true });
  writeFileSync(join(examples, `${fixture}.rs`), 'stale\n');
  const run = spawnSync(process.execPath, [runner, toolchain, '--case', fixture], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.equal(existsSync(examples), false, 'packages/rust/tests/examples is removed after the run');
});
