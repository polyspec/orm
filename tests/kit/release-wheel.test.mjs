// Tests of the Python wheel package kind: the PEP 427 name, the build from the tagged commit with the pinned build backend,
// the refusal of a Requires-Dist that is not a plain name==version, the version in pyproject.toml, the download of the
// build backend (release-backend.mjs) and the consumer install with --require-hashes (release-consumer.mjs). The Python of
// the sandbox is the pip stub of wheel-stubs.mjs; no test reaches an index.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sha256, fileDigest } from '../../scripts/kit/digest.mjs';
import * as release from '../../scripts/kit/release.mjs';
import * as wheel from '../../scripts/kit/release-wheel.mjs';
import * as backend from '../../scripts/kit/release-backend.mjs';
import * as consumer from '../../scripts/kit/release-consumer.mjs';
import { Stop } from '../../scripts/kit/process.mjs';
import { readJson, releaseSandbox, writeJson } from './release-sandbox.mjs';
import { consumerSandbox } from './release-consumer-sandbox.mjs';
import { BACKEND_BYTES, BACKEND_FILE } from './wheel-stubs.mjs';

const stop = (fn, pattern) => assert.throws(fn, error => error instanceof Stop && pattern.test(error.message), String(pattern));
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WHEEL = 'kit_fixture-0.0.1-py3-none-any.whl';
const PYPROJECT = 'packages/fixture-python/pyproject.toml';
const BACKEND_SHA = sha256(BACKEND_BYTES);
const context = box => release.context(box.root, { env: box.env });
const backendPath = box => path.join(box.root, 'var/tools/wheels', BACKEND_FILE);
const editPyproject = (root, change) => writeFileSync(path.join(root, PYPROJECT), change(readFileSync(path.join(root, PYPROJECT), 'utf8')));

test('a wheel is named by PEP 427 and the archive names of the configuration hold it', (t) => {
  const box = releaseSandbox(t);
  assert.equal(wheel.wheelName('kit-fixture', '0.0.1'), WHEEL);
  assert.ok(release.assetNames(release.loadConfig(box.root), '0.0.1').includes(WHEEL));
});

test('assets builds the wheel of the tagged commit offline with the pinned build backend', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  const names = release.assets(context(box), tag);
  assert.ok(names.includes(WHEEL));
  const file = path.join(box.root, release.ASSETS, WHEEL);
  assert.ok(existsSync(file), 'the wheel is in var/release/assets');
  const metadata = spawnSync('unzip', ['-p', file, '*.dist-info/METADATA'], { encoding: 'utf8' }).stdout;
  assert.match(metadata, /^Name: kit-fixture$/m);
  assert.match(metadata, /^Version: 0\.0\.1$/m);
  const [build] = box.pipCalls().filter(call => call.args[2] === 'wheel');
  assert.ok(build, 'pip wheel ran once');
  for (const flag of ['--no-deps', '--no-index']) assert.ok(build.args.includes(flag), `${flag} is passed`);
  const find = build.args.indexOf('--find-links');
  assert.deepEqual(build.args.slice(find, find + 2), ['--find-links', path.join(box.root, 'var/tools/wheels')], 'the backend is the only index');
  assert.ok(!build.args.at(-1).startsWith(box.root), 'the wheel is built from a copy of the tagged commit, not the working tree');
});

test('assets refuses a pyproject.toml whose project name differs from the configuration before it builds', (t) => {
  const box = releaseSandbox(t, { mutate: root => editPyproject(root, text => text.replace('name = "kit-fixture"', 'name = "other-name"')) });
  const tag = box.release('0.0.1');
  stop(() => release.assets(context(box), tag), /packages\/fixture-python\/pyproject\.toml: name other-name, config\/release\.json declares kit-fixture/);
  assert.deepEqual(box.pipCalls(), []);
});

test('assets refuses a Requires-Dist that is neither a registry pin nor a polyspec release asset, and names it', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  const refused = [
    ['kit-git @ git+https://example.com/kit-git.git', 'a git source'],
    ['kit-range>=1.0', 'a range'],
    ['kit-extra==1.0.0; extra == "dev"', 'a marker'],
    ['kit-marker==1.0.0; python_version < "3.10"', 'a marker'],
  ];
  for (const [line, form] of refused) {
    box.wheelRequires([line]);
    stop(() => release.assets(context(box), tag), new RegExp(escaped(`Requires-Dist ${line} is ${form}, not name==version or a polyspec release asset with a sha256 fragment`)));
  }
});

test('assets refuses a URL that names a package consumers.wheel.polyspec does not declare, and names it', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  const line = 'kit-url @ https://example.com/kit-url-1.0.0-py3-none-any.whl#sha256=' + 'a'.repeat(64);
  box.wheelRequires([line]);
  stop(() => release.assets(context(box), tag), new RegExp(escaped(`Requires-Dist ${line} names kit-url, which consumers.wheel.polyspec does not declare`)));
});

test('assets accepts a Requires-Dist that is a plain name==version the lock holds', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  box.wheelRequires(['ruff==0.16.10']);
  assert.ok(release.assets(context(box), tag).includes(WHEEL));
});

test('assets refuses a Requires-Dist that the lock of the wheel does not hold, and names the lock', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  box.wheelRequires(['six==1.16.0']);
  stop(() => release.assets(context(box), tag), /six==1\.16\.0 has no entry in packages\/fixture-python\/pylock\.wheel\.toml/);
});

const KIT_LIB_URL = 'https://github.com/polyspec/kit-lib/releases/download/v0.0.1/kit_lib-0.0.1-py3-none-any.whl';
const KIT_LIB_SHA = 'a'.repeat(64);
// A sandbox whose config declares kit-lib as a polyspec package and whose lock holds its release asset.
const polyspecSandbox = (t) => releaseSandbox(t, {
  mutate: (root) => {
    const config = readJson(root, 'config/release.json');
    writeJson(root, 'config/release.json', { ...config, consumers: { ...config.consumers, wheel: { ...config.consumers.wheel, polyspec: { 'kit-lib': 'https://github.com/polyspec/kit-lib' } } } });
    const lock = readFileSync(path.join(root, 'packages/fixture-python/pylock.wheel.toml'), 'utf8');
    writeFileSync(path.join(root, 'packages/fixture-python/pylock.wheel.toml'), `${lock}\n[[packages]]\nname = "kit-lib"\nversion = "0.0.1"\narchive = { url = "${KIT_LIB_URL}", hashes = { sha256 = "${KIT_LIB_SHA}" } }\n`);
  },
});

test('assets accepts a polyspec direct reference whose fragment is the sha256 of the lock', (t) => {
  const box = polyspecSandbox(t);
  const tag = box.release('0.0.1');
  box.wheelRequires([`kit-lib @ ${KIT_LIB_URL}#sha256=${KIT_LIB_SHA}`]);
  assert.ok(release.assets(context(box), tag).includes(WHEEL));
});

test('assets refuses a polyspec reference without its fragment, before it packs the wheel', (t) => {
  const box = polyspecSandbox(t);
  const tag = box.release('0.0.1');
  box.wheelRequires([`kit-lib @ ${KIT_LIB_URL}`]);
  stop(() => release.assets(context(box), tag), /kit-lib @ .* has no #sha256= fragment/);
  assert.equal(box.pipCalls().filter(call => call.args[2] === 'wheel').length, 1, 'the build ran once, the metadata check refused the wheel after it');
});

test('assets refuses a polyspec fragment that differs from the sha256 of the lock', (t) => {
  const box = polyspecSandbox(t);
  const tag = box.release('0.0.1');
  box.wheelRequires([`kit-lib @ ${KIT_LIB_URL}#sha256=${'b'.repeat(64)}`]);
  stop(() => release.assets(context(box), tag), new RegExp(`the fragment has the sha256 ${'b'.repeat(64)}, packages/fixture-python/pylock\\.wheel\\.toml holds ${KIT_LIB_SHA} for kit-lib`));
});

test('assets refuses a pyproject whose build backend is not the pinned requirement, before it builds', (t) => {
  const box = releaseSandbox(t, { mutate: root => editPyproject(root, text => text.replace('setuptools==84.0.0', 'setuptools==83.0.0')) });
  const tag = box.release('0.0.1');
  stop(() => release.assets(context(box), tag), /build-system\.requires is \["setuptools==83\.0\.0"\], the buildBackend pins setuptools==84\.0\.0/);
  assert.deepEqual(box.pipCalls(), []);
});

test('assets refuses a build backend file whose sha256 differs from the declaration, before it builds', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  writeFileSync(backendPath(box), 'tampered');
  stop(() => release.assets(context(box), tag), new RegExp(`${escaped(path.join('var/tools/wheels', BACKEND_FILE))} has the sha256 [0-9a-f]{64}, config/release\\.json buildBackend declares ${BACKEND_SHA}`));
  assert.deepEqual(box.pipCalls(), []);
});

test('assets without the build backend file names the command that fetches it', (t) => {
  const box = releaseSandbox(t);
  const tag = box.release('0.0.1');
  rmSync(backendPath(box));
  stop(() => release.assets(context(box), tag), new RegExp(`${escaped(path.join('var/tools/wheels', BACKEND_FILE))} is missing; make release-backend fetches it`));
});

test('versions requires the version in pyproject.toml', (t) => {
  const box = releaseSandbox(t, { mutate: root => editPyproject(root, text => text.replace(/^version = .*\n/m, '')) });
  const tag = box.release('0.0.1');
  stop(() => release.versions(context(box), tag), /packages\/fixture-python\/pyproject\.toml: version none, the tag v0\.0\.1 is 0\.0\.1/);
});

test('release-backend downloads the pinned build backend with its hash and keeps it when the hash matches', (t) => {
  const box = releaseSandbox(t);
  rmSync(backendPath(box));
  backend.fetchBackend(context(box));
  const [download] = box.pipCalls().filter(call => call.args[2] === 'download');
  assert.ok(download, 'pip download ran once');
  for (const flag of ['--no-deps', '--require-hashes', '--only-binary']) assert.ok(download.args.includes(flag), `${flag} is passed`);
  assert.equal(download.args[download.args.indexOf('--only-binary') + 1], ':all:');
  assert.equal(download.args[download.args.indexOf('-d') + 1], path.join(box.root, 'var/tools/wheels'));
  assert.equal(download.requirements.trim(), `setuptools==84.0.0 --hash=sha256:${BACKEND_SHA}`);
  assert.equal(fileDigest(backendPath(box)), BACKEND_SHA);
});

test('release-backend removes a download whose sha256 differs from the declaration and names both', (t) => {
  const box = releaseSandbox(t);
  const config = readJson(box.root, 'config/release.json');
  writeJson(box.root, 'config/release.json', { ...config, buildBackend: { ...config.buildBackend, sha256: '0'.repeat(64) } });
  rmSync(backendPath(box));
  stop(() => backend.fetchBackend(context(box)), new RegExp(`has the sha256 ${BACKEND_SHA}, config/release\\.json buildBackend declares ${'0'.repeat(64)}`));
  assert.equal(existsSync(backendPath(box)), false);
});

test('release-consumer installs the wheel with --no-index and --require-hashes in a clean venv and runs its smoke import', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  assert.equal(consumer.installConsumers(box.ctx(), '0.0.1', path.join(box.root, release.ASSETS)), 4);
  const [venvCall] = box.calls('checkout-python3').filter(call => call.args[1] === 'venv');
  assert.deepEqual(venvCall.args.slice(0, 4), ['-m', 'venv', '--copies', '--without-pip'], 'the venv is made through makeVenv: a copy of the checkout Python with no pip');
  const venv = venvCall.args[4];
  const dependencies = box.calls('checkout-python3').find(call => call.args.includes('--only-binary'));
  assert.equal(dependencies.requirements, `ruff==0.16.10 --hash=sha256:${'1'.repeat(64)}\n`, 'the lock of the wheel is installed with its hashes first');
  assert.ok(box.calls('checkout-python3').some(call => call.args.at(-1) === 'check'), 'pip check runs in the venv');
  const install = box.calls('checkout-python3').find(call => call.args.includes('--no-index'));
  assert.ok(install, 'pip install ran');
  assert.deepEqual(install.args.slice(0, 9), ['-m', 'pip', '--python', path.join(venv, 'bin', 'python'), 'install', '--no-input', '--disable-pip-version-check', '--no-index', '--require-hashes']);
  assert.ok(install.args.includes('--no-deps'));
  assert.equal(install.requirements, `${path.join(box.root, release.ASSETS, WHEEL)} --hash=sha256:${fileDigest(path.join(box.root, release.ASSETS, WHEEL))}\n`);
  assert.ok(box.calls('python').some(call => call.args.join(' ') === '-c import kit_fixture'), 'the smoke import ran');
});

test('release-consumer names an installed wheel whose version differs from the tag', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  box.stub({ version: '9.9.9' });
  stop(() => consumer.installConsumers(box.ctx(), '0.0.1', path.join(box.root, release.ASSETS)), /wheel installed kit-fixture 9\.9\.9, expected 0\.0\.1/);
});

test('release-consumer stops when the smoke import of the wheel fails and names the command', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  box.stub({ modes: { python: 'smoke-fail' } });
  stop(() => consumer.installConsumers(box.ctx(), '0.0.1', path.join(box.root, release.ASSETS)), /python -c import kit_fixture exited with 1: python stub: ModuleNotFoundError/);
});

test('config: a wheel package needs its consumer smoke and a pinned build backend; a Python git-tag is refused', (t) => {
  const edit = (change) => {
    const box = releaseSandbox(t);
    const config = readJson(box.root, 'config/release.json');
    writeJson(box.root, 'config/release.json', change(structuredClone(config)));
    return box;
  };
  stop(() => release.loadConfig(edit(c => { delete c.consumers.wheel; return c; }).root), /consumers\.wheel is missing; the wheel packages \[kit-fixture\] need a consumer project that installs them/);
  stop(() => release.loadConfig(edit(c => { delete c.buildBackend; return c; }).root), /buildBackend is missing; the wheel packages \[kit-fixture\] need a pinned build backend/);
  stop(() => release.loadConfig(edit(c => { c.proof.gitTag['packages/fixture-rust/Cargo.toml'].kind = 'python'; return c; }).root), /proof\.gitTag\.packages\/fixture-rust\/Cargo\.toml\.kind is "python", the allowed values are rust/);
});
