// Tests of the PEP 751 lock of a Python project (pylock.toml) in the dependency tools: the parser reads the tables that uv and pip
// write and names the line of a construct it does not read; the gate fails on a package without a hash, a git pin that is not a
// full commit, a missing created-by, a local directory package and a lock format that is not 1.0; the review records the git
// pins, queries PyPI for the latest release and the advisories of each registry package, and names the tool of created-by in
// the fix. The fixture is tests/kit/fixture/packages/fixture-python/pylock.toml, written by uv; no test uses the network.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseToml, readPylock } from '../../scripts/kit/pylock.mjs';
import { validate } from '../../scripts/kit/schema-validate.mjs';
import { fixtureCheckout as fixture, gate, installCargoAuditStub, installGovulncheckStub, review } from './checkout.mjs';
import { FIXTURE_REGISTRY, stubRegistries } from './registry.mjs';

const LOCK = 'packages/fixture-python/pylock.toml';
const findings = result => result.stderr.split('\n').filter(line => line.startsWith('[dependency-policy] ') && !line.includes(' finding'));
const lockText = root => readFileSync(path.join(root, LOCK), 'utf8');
const writeLock = (root, text) => writeFileSync(path.join(root, LOCK), text);
const CLICK_WHEEL_HASH = 'hashes = { sha256 = "ae74fb96c20a0277a1d615f1e4d73c8414f5a98db8b799a7931d1582f3390c28" }';
const PIP_TOOLS_COMMIT = '60ebdf5d1625cb63d0b94326035e0aa209659f4d';

test('the parser reads the tables of a uv export: registry files with their hashes and a git pin with its commit', (t) => {
  const root = fixture(t);
  const lock = readPylock(lockText(root), LOCK);
  assert.equal(lock.lockVersion, '1.0');
  assert.equal(lock.createdBy, 'uv');
  const [click, pipTools] = lock.packages;
  assert.equal(click.kind, 'registry');
  assert.equal(click.name, 'click');
  assert.equal(click.version, '8.1.7');
  assert.deepEqual(click.files.map(file => file.sha256), [
    'ca9853ad459e787e2192211578cc907e7594e294c7ccc834310722b41b9ca6de',
    'ae74fb96c20a0277a1d615f1e4d73c8414f5a98db8b799a7931d1582f3390c28',
  ]);
  assert.equal(pipTools.kind, 'vcs');
  assert.deepEqual(pipTools.vcs, {
    type: 'git', url: 'https://github.com/jazzband/pip-tools', requestedRevision: '7.4.1', commitId: PIP_TOOLS_COMMIT, subdirectory: null,
  });
});

test('the parser refuses a construct it does not read and names its line', () => {
  assert.throws(() => parseToml('name = "a"\nnote = """multi\nline"""\n'), /line 2: .*multi-line string/);
  assert.throws(() => parseToml('a = 1\na = 2\n'), /line 2: a is already defined/);
});

test('the gate fails on a registry file without a sha256 and names the file, the rule and the fix', (t) => {
  const root = fixture(t);
  writeLock(root, lockText(root).replace(CLICK_WHEEL_HASH, 'hashes = {}'));
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.ok(findings(result).some(line => /^\[dependency-policy\] packages\/fixture-python\/pylock\.toml click: .+ has no sha256\. Rule: .+PEP 751.+\. Fix: regenerate/.test(line)), result.stderr);
});

test('the gate fails on a git pin whose commit-id is not a full 40-digit commit', (t) => {
  const root = fixture(t);
  writeLock(root, lockText(root).replace(PIP_TOOLS_COMMIT, '60ebdf5'));
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.ok(findings(result).some(line => line.startsWith('[dependency-policy] packages/fixture-python/pylock.toml pip-tools: commit-id is 60ebdf5, a git commit is 40 hexadecimal digits')), result.stderr);
});

test('the gate fails on a lock without created-by, since no tool can then be named for its regeneration', (t) => {
  const root = fixture(t);
  writeLock(root, lockText(root).replace('created-by = "uv"\n', ''));
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.ok(findings(result).some(line => line.startsWith(`[dependency-policy] ${LOCK}: the lock names no tool in created-by`)), result.stderr);
});

test('the gate refuses a local directory package, which a consumer cannot install from a lock exported without the project', (t) => {
  const root = fixture(t);
  writeLock(root, `${lockText(root)}\n[[packages]]\nname = "local-lib"\nversion = "0.0.1"\ndirectory = { path = "." }\n`);
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.ok(findings(result).some(line => line.startsWith(`[dependency-policy] ${LOCK} local-lib: is a local directory`)), result.stderr);
});

test('the gate reads only lock-version 1.0 and fails on any other format', (t) => {
  const root = fixture(t);
  writeLock(root, lockText(root).replace('lock-version = "1.0"', 'lock-version = "2.0"'));
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lock-version is "2\.0", PEP 751 requires "1\.0"/);
});

test('the review records the git pin of the lock, and the gate fails when the record names another commit', (t) => {
  const root = fixture(t);
  const record = JSON.parse(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'));
  record.vcs = record.vcs.map(item => ({ ...item, commitId: '0'.repeat(40) }));
  writeFileSync(path.join(root, 'config/dependency-review.json'), `${JSON.stringify(record, null, 2)}\n`);
  const result = gate(root);
  assert.equal(result.status, 1);
  assert.ok(findings(result).some(line => line.startsWith(`[dependency-policy] ${LOCK} pip-tools: the lock pins ${PIP_TOOLS_COMMIT} at 7.4.1, the review of`)), result.stderr);
});

test('the review names a newer PyPI release of a registry package with the uv regeneration', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  const stub = stubRegistries(t);
  stub.registry({ ...FIXTURE_REGISTRY, pypi: { ...FIXTURE_REGISTRY.pypi, click: { '8.1.7': [{}], '8.1.8': [{}] } } });
  const result = review(root, [], stub.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[dependency-review\] packages\/fixture-python\/pylock\.toml click 8\.1\.7 < 8\.1\.8: a newer stable release exists\. Fix: regenerate packages\/fixture-python\/pylock\.toml with uv: uv lock --upgrade-package click, then uv export --format pylock\.toml --frozen --no-emit-project -o packages\/fixture-python\/pylock\.toml, then make dependency-review RECORD=1\.$/m);
});

test('the review names pip lock as the regeneration of a lock that pip wrote', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  writeLock(root, lockText(root).replace('created-by = "uv"', 'created-by = "pip"'));
  const stub = stubRegistries(t);
  stub.registry({ ...FIXTURE_REGISTRY, pypi: { ...FIXTURE_REGISTRY.pypi, click: { '8.1.7': [{}], '8.1.8': [{}] } } });
  const result = review(root, [], stub.env);
  assert.match(result.stdout, /click 8\.1\.7 < 8\.1\.8: a newer stable release exists\. Fix: regenerate packages\/fixture-python\/pylock\.toml with pip: pip lock, then make dependency-review RECORD=1\./);
});

test('the review reports the PyPI advisories of a registry package at its locked version', (t) => {
  const root = fixture(t);
  installCargoAuditStub(root);
  installGovulncheckStub(root);
  const stub = stubRegistries(t);
  stub.registry({ ...FIXTURE_REGISTRY, pypiVulnerabilities: { click: { '8.1.7': [{ id: 'GHSA-test-0001', summary: 'test advisory', link: 'https://example.org/advisory', aliases: [], fixed_in: ['8.1.8'], withdrawn: null }] } } });
  const result = review(root, ['--record'], stub.env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^\[dependency-review\] packages\/fixture-python\/pylock\.toml click 8\.1\.7: advisory GHSA-test-0001 \(vulnerability\) test advisory https:\/\/example\.org\/advisory\. Fix: regenerate packages\/fixture-python\/pylock\.toml with uv:/m);
  const record = JSON.parse(readFileSync(path.join(root, 'config/dependency-review.json'), 'utf8'));
  const locked = record.locks.find(entry => entry.lock === LOCK);
  assert.deepEqual(locked.advisories.map(item => [item.package, item.version, item.id]), [['click', '8.1.7', 'GHSA-test-0001']]);
});

test('the policy names a PEP 751 lock only by pylock.toml or pylock.<name>.toml, at the root or below it', () => {
  const schema = JSON.parse(readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/kit/schema/dependency-policy.schema.json'), 'utf8'));
  const policy = lock => ({ schema: 1, composerPlatforms: [], pythonManifests: [], pythonLocks: [lock], npmLocks: [], exceptions: [] });
  for (const lock of ['pylock.toml', 'packages/x-python/pylock.toml', 'pylock.dev.toml']) assert.deepEqual(validate(policy(lock), schema), [], lock);
  for (const lock of ['uv.lock', 'requirements.txt', 'packages/x/pylock.lock', '/pylock.toml']) assert.notDeepEqual(validate(policy(lock), schema), [], lock);
});
