// Tests of a sibling: a wheel package of the same config/release.json as the wheel that requires it. Its Requires-Dist is a direct
// reference to its release asset of this release WITHOUT a hash fragment, since its sha256 is known only after the release builds
// it. The check accepts it only when the name is a wheel package of the configuration, the URL is under config.repositoryUrl at
// /releases/download/v<V>/ for the version V of the release, and the file is the PEP 427 name of that version. The sibling is not in
// the lock of the wheel. The METADATA and the lock are texts built here; no test reaches a network.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as dependencies from '../../scripts/kit/wheel-dependencies.mjs';
import * as consumerConfig from '../../scripts/kit/release-consumer-config.mjs';

const LOCK = 'packages/fixture-python/pylock.wheel.toml';
const REPO = 'https://example.com/polyspec/kit-fixture';
const SIBLING = 'kit-fixture-validator';
const FILE = 'kit_fixture_validator-0.0.1-py3-none-any.whl';
const URL = `${REPO}/releases/download/v0.0.1/${FILE}`;
const SHA = 'a'.repeat(64);
const RUFF = `[[packages]]\nname = "ruff"\nversion = "0.16.10"\nwheels = [{ name = "ruff-0.16.10-py3-none-any.whl", url = "https://files.pythonhosted.org/packages/ruff-0.16.10-py3-none-any.whl", hashes = { sha256 = "${'1'.repeat(64)}" } }]\n`;
const LOCK_TEXT = `lock-version = "1.0"\ncreated-by = "uv"\n\n${RUFF}`;
const metadata = (...requires) => ['Metadata-Version: 2.4', 'Name: kit-fixture', 'Version: 0.0.1', ...requires.map(line => `Requires-Dist: ${line}`)].join('\n') + '\n';
const problemsOf = (requires, { lockText = LOCK_TEXT, siblings = [SIBLING], repositoryUrl = REPO } = {}) => dependencies.wheelDependencyProblems({ metadata: metadata(...requires), name: 'kit-fixture', version: '0.0.1', polyspec: {}, siblings, repositoryUrl, lockFile: LOCK, lockText });
const LOCK_WITH_SIBLING = `${LOCK_TEXT}\n[[packages]]\nname = "${SIBLING}"\nversion = "0.0.1"\narchive = { url = "${URL}", hashes = { sha256 = "${SHA}" } }\n`;

test('the siblings of a wheel are the other wheel packages of the configuration, derived from packages', () => {
  const config = { packages: [{ kind: 'wheel', name: 'kit-fixture' }, { kind: 'npm', name: 'fixture-lib' }, { kind: 'wheel', name: SIBLING }] };
  assert.deepEqual(dependencies.siblingsOf(config, 'kit-fixture'), [SIBLING]);
  assert.deepEqual(dependencies.siblingsOf(config, SIBLING), ['kit-fixture']);
  assert.deepEqual(dependencies.siblingsOf({ packages: [{ kind: 'wheel', name: 'kit-fixture' }] }, 'kit-fixture'), []);
});

test('a sibling named by its release asset without a hash is accepted, and the lock need not hold it', () => {
  assert.deepEqual(problemsOf([`${SIBLING} @ ${URL}`, 'ruff==0.16.10']), []);
});

test('a sibling named with a #sha256 fragment is refused', () => {
  const line = `${SIBLING} @ ${URL}#sha256=${SHA}`;
  assert.deepEqual(problemsOf([line]), [`Requires-Dist ${line} names the sibling ${SIBLING} of this release with a #sha256 fragment; a sibling is named by its URL without a hash, since its sha256 is known only after the release builds it`]);
});

test('a sibling named by name==version is refused', () => {
  assert.deepEqual(problemsOf([`${SIBLING}==0.0.1`]), [`Requires-Dist ${SIBLING}==0.0.1 names the sibling ${SIBLING} of this release by name==version; it must be a direct reference to its release asset`]);
});

test('a sibling at another version of the release is refused and names both versions', () => {
  const line = `${SIBLING} @ ${REPO}/releases/download/v0.0.2/kit_fixture_validator-0.0.2-py3-none-any.whl`;
  assert.deepEqual(problemsOf([line]), [`Requires-Dist ${line} names ${SIBLING} at v0.0.2, the release is v0.0.1`]);
});

test('a sibling from another repository is refused', () => {
  const other = `https://example.com/polyspec/other/releases/download/v0.0.1/${FILE}`;
  assert.deepEqual(problemsOf([`${SIBLING} @ ${other}`]), [`Requires-Dist ${SIBLING} @ ${other} is not a release asset of ${REPO}, the repository of this release`]);
});

test('a sibling on another host with the same path is refused', () => {
  const other = `https://example.org/polyspec/kit-fixture/releases/download/v0.0.1/${FILE}`;
  assert.deepEqual(problemsOf([`${SIBLING} @ ${other}`]), [`Requires-Dist ${SIBLING} @ ${other} is not a release asset of ${REPO}, the repository of this release`]);
});

test('a sibling whose file is not the PEP 427 name of its version is refused and names both', () => {
  const wrong = `${REPO}/releases/download/v0.0.1/kit_other-0.0.1-py3-none-any.whl`;
  assert.deepEqual(problemsOf([`${SIBLING} @ ${wrong}`]), [`Requires-Dist ${SIBLING} @ ${wrong}: the file kit_other-0.0.1-py3-none-any.whl of v0.0.1 is not ${FILE}`]);
});

test('a sibling with a marker or a git source is refused by its form', () => {
  assert.deepEqual(problemsOf([`${SIBLING} @ ${URL}; python_version >= "3.10"`]), [`Requires-Dist ${SIBLING} @ ${URL}; python_version >= "3.10" is a marker, not name==version or a polyspec release asset with a sha256 fragment`]);
});

test('a lock that holds the sibling is refused, since its hash would be needed before the release builds it', () => {
  assert.deepEqual(problemsOf([`${SIBLING} @ ${URL}`], { lockText: LOCK_WITH_SIBLING }), [`${LOCK}: ${SIBLING} is a wheel of this release; the lock of kit-fixture holds no sibling, since its sha256 is known only after the release builds it. Fix: remove ${SIBLING} from ${LOCK}`]);
});

test('a configuration that declares a wheel package as a polyspec distribution is refused', () => {
  const config = {
    packages: [{ kind: 'wheel', name: 'kit-fixture' }, { kind: 'wheel', name: SIBLING }],
    consumers: { wheel: { smoke: { 'kit-fixture': ['python', '-c', 'import kit_fixture'], [SIBLING]: ['python', '-c', 'import kit_fixture_validator'] }, lock: { 'kit-fixture': LOCK, [SIBLING]: 'packages/fixture-validator/pylock.wheel.toml' }, polyspec: { [SIBLING]: REPO } } },
  };
  assert.deepEqual(consumerConfig.consumerConfigProblems(config), [`consumers.wheel.polyspec.${SIBLING} names the wheel package ${SIBLING} of this repository; a sibling of the release needs no declaration`]);
});

test('siblingLinks returns the direct references of the METADATA to the siblings, and no other line', () => {
  const text = metadata('ruff==0.16.10', `${SIBLING} @ ${URL}`, `other-lib @ https://example.com/other/other_lib-0.0.1-py3-none-any.whl`);
  assert.deepEqual(dependencies.siblingLinks(text, [SIBLING]), [{ name: SIBLING, url: URL }]);
  assert.deepEqual(dependencies.siblingLinks(text, []), []);
});
