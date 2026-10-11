// Tests of the ruff pin of config/toolchain.json in the dependency review: the pin is a PyPI dependency of the state, its newer
// release is fixed by hand with the sha256 of its wheels, and updatePlan never edits the toolchain file. The checkout is the
// fixture copy of tests/kit/checkout.mjs; nothing reaches a network.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { POLICY, TOOLCHAIN, UPDATE, readState } from '../../scripts/kit/dependency-state.mjs';
import { fixOf, updatePlan } from '../../scripts/kit/dependency-review.mjs';
import { fixtureCheckout as fixture } from './checkout.mjs';

const RUFF = { version: '0.16.10', sha256: { 'linux-x64': 'f33f43a864a8483eebd160e713336c8bab02c934feaff0a33cf5ccb41546d09a' } };
const toolchainRuff = { ecosystem: 'pypi', manifest: TOOLCHAIN, package: 'ruff', kind: 'toolchain', spec: '==0.16.10', version: '0.16.10', lock: null };
const policyOf = root => JSON.parse(readFileSync(path.join(root, POLICY), 'utf8'));

test('the ruff pin of config/toolchain.json is a PyPI dependency of the review state', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, TOOLCHAIN), JSON.stringify({ schema: 1, ruff: RUFF }));
  const state = readState(root, policyOf(root));
  assert.deepEqual(state.dependencies.filter(dependency => dependency.manifest === TOOLCHAIN), [toolchainRuff]);
});

test('a checkout without a ruff pin has no toolchain dependency', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, TOOLCHAIN), JSON.stringify({ schema: 1, python: '3.14' }));
  const state = readState(root, policyOf(root));
  assert.equal(state.dependencies.some(dependency => dependency.manifest === TOOLCHAIN), false);
});

test('a newer ruff pin is set by hand with the digests of its wheels, and updatePlan never edits the toolchain file', () => {
  assert.equal(fixOf({ ...toolchainRuff, latest: '0.16.11' }), `set ruff in ${TOOLCHAIN} to 0.16.11 with the sha256 of each wheel, then make install-tools`);
  assert.equal(fixOf({ ...toolchainRuff, manifest: 'pyproject.toml', latest: '0.16.11' }), UPDATE);
  assert.deepEqual(updatePlan({ newer: [{ ...toolchainRuff, latest: '0.16.11' }], advisories: [] }), []);
});
