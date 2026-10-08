// Tests of the dependency tools on the fixture of tests/kit/fixture (package.json, packages/fixture-php, packages/fixture-python,
// config/): the gate passes on the fixture, fails on a lock changed without a review, and the review records the fixture
// the same way on every run. The registries are stubs (tests/kit/registry.mjs), so no test queries the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE_REGISTRY, stubRegistries } from './registry.mjs';

import { fixtureCheckout as fixture, gate, installCargoAuditStub, installGovulncheckStub, review } from './checkout.mjs';

test('the gate passes on the fixture and queries no registry', (t) => {
  const root = fixture(t);
  const stub = stubRegistries(t);
  const result = gate(root, stub.env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[dependency-policy\] 6 registry dependencies and 4 locks match the review of /m);
  assert.equal(stub.calls().filter(call => !call.startsWith('composer validate ')).length, 0, stub.calls().join('\n'));
});

test('the gate fails on a lock changed without a review and names the file, the review and the fix', (t) => {
  const root = fixture(t);
  appendFileSync(path.join(root, 'packages/fixture-php/composer.lock'), '\n');
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^\[dependency-policy\] packages\/fixture-php\/composer\.lock: the lock changed after the review of .+: its sha256 is [0-9a-f]{64}, the review recorded [0-9a-f]{64}\./m);
});

test('the review reports a newer stable release with the fix command and writes no record without RECORD', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  const stub = stubRegistries(t);
  stub.registry({ ...FIXTURE_REGISTRY, npm: { ...FIXTURE_REGISTRY.npm, 'is-number': ['7.0.0', '7.1.0'] } });
  const before = readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8');
  const result = review(root, [], stub.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[dependency-review\] package\.json is-number 7\.0\.0 < 7\.1\.0: a newer stable release exists\. Fix: make dependency-review UPDATE=1\.$/m);
  assert.equal(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'), before);
});

test('the review records the fixture, and a second run writes the same record', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  const stub = stubRegistries(t);
  stub.registry(FIXTURE_REGISTRY);
  const first = review(root, ['--record'], stub.env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const once = JSON.parse(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'));
  const second = review(root, ['--record'], stub.env);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const twice = JSON.parse(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'));
  assert.deepEqual({ ...twice, reviewed: null }, { ...once, reviewed: null });
  assert.deepEqual(twice.dependencies.map(item => [item.ecosystem, item.package, item.version]), [
    ['npm', 'is-number', '7.0.0'], ['npm', 'semver', '7.6.0'], ['composer', 'psr/log', '3.0.2'], ['pypi', 'setuptools', '84.0.0'], ['pypi', 'ruff', '0.16.10'], ['go', 'github.com/google/uuid', 'v1.6.0'],
  ]);
});

test('the mutation check rejects every mutation of the fixture', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, ['scripts/kit/check-dependency-policy-mutation.mjs'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /4 mutations rejected/);
});

test('the mutation check applies to the ecosystems of the repository: no Composer platform, and a record that starts with a Python dependency', (t) => {
  const root = fixture(t);
  const edit = (file, change) => {
    const data = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
    change(data);
    writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  };
  edit('config/dependency-policy.json', (policy) => { policy.composerPlatforms = []; });
  edit('config/dependency-review.json', (record) => { record.dependencies = record.dependencies.filter(entry => entry.ecosystem === 'pypi'); });
  const result = spawnSync(process.execPath, ['scripts/kit/check-dependency-policy-mutation.mjs'], { cwd: root, encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /3 mutations rejected/);
});

test('a package that the root overrides install from a URL is not reviewed against the registry', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.overrides = { 'is-number': 'https://example.org/releases/is-number-7.0.0.tgz' };
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const stub = stubRegistries(t);
  stub.registry({ ...FIXTURE_REGISTRY, npm: Object.fromEntries(Object.entries(FIXTURE_REGISTRY.npm).filter(([name]) => name !== 'is-number')) });
  const result = review(root, ['--record'], stub.env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const record = JSON.parse(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'));
  assert.equal(record.dependencies.some(entry => entry.package === 'is-number'), false);
});
