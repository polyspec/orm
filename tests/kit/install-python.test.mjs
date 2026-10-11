// Tests of scripts/kit/install-python.mjs and its install-tools step: the Python of pythonBuild is downloaded from its
// release, verified by its declared sha256, unpacked into var/tools/python-build, wrapped as var/tools/bin/python3, and
// kept by a second run. curl is a PATH stub that copies the archive of the test; no test reaches the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installPython, PYTHON_TRIPLES } from '../../scripts/kit/install-python.mjs';
import { toolchainCheckout } from './toolchain-checkout.mjs';
import { pythonBuild, toolchainStubs } from './toolchain-stubs.mjs';

const config = value => JSON.stringify({ schema: 1, ...value });
const install = (root, env, ...tools) => spawnSync(process.execPath, ['scripts/kit/install-tools.mjs', ...tools], { cwd: root, env, encoding: 'utf8' });
const run = (file, env) => spawnSync(file, ['--version'], { encoding: 'utf8', env }).stdout.trim();

test('the declared Python is downloaded, verified, unpacked and wrapped as var/tools/bin/python3, and a second run keeps it', (t) => {
  const py = pythonBuild(t);
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: py.declared }) });
  const stubs = toolchainStubs(t, { downloads: { [py.url]: py.archive } });
  const first = install(root, stubs.env, 'python');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /\[install-tools\] Python: none is installed in var\/tools\/python-build; installing 3\.14\.8/);
  assert.match(first.stdout, /\[install-tools\] Python: installed 3\.14\.8 in var\/tools\/python-build/);
  assert.deepEqual(stubs.calls().map(line => line.split(' ')[0]), ['curl', 'python3.14'], 'the download, then the version probe of the installed release');
  assert.equal(run(path.join(root, 'var/tools/bin/python3'), stubs.env), 'Python 3.14.8');
  assert.deepEqual(readdirSync(path.join(root, 'var/tools/python-build')).sort(), ['python']);
  assert.equal(install(root, stubs.env, 'python').status, 0);
  assert.equal(stubs.calls().filter(line => line.startsWith('curl')).length, 1, 'a second run downloads nothing');
});

test('an archive with another digest is refused, nothing is installed, and the error names both digests', (t) => {
  const py = pythonBuild(t);
  const declared = { ...py.declared, sha256: { [py.key]: 'a'.repeat(64) } };
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: declared }) });
  const stubs = toolchainStubs(t, { downloads: { [py.url]: py.archive } });
  const result = install(root, stubs.env, 'python');
  assert.equal(result.status, 1);
  const actual = createHash('sha256').update(readFileSync(py.archive)).digest('hex');
  assert.match(result.stderr, new RegExp(`${py.url.replaceAll('.', '\\.').replaceAll('+', '\\+')} has the sha256 ${actual}; config/toolchain\\.json pythonBuild declares ${'a'.repeat(64)} for ${py.key}`));
  assert.deepEqual(readdirSync(path.join(root, 'var/tools')), []);
});

test('a platform without a verified build or without a declared digest fails with the platforms and the fix', (t) => {
  const py = pythonBuild(t);
  const root = toolchainCheckout(t);
  assert.throws(() => installPython({ root, declared: py.declared, platform: 'win32-x64' }), /no Python build is verified for win32-x64; the verified platforms are darwin-arm64, darwin-x64, linux-x64, linux-arm64/);
  const other = Object.keys(PYTHON_TRIPLES).find(key => key !== py.key);
  assert.throws(() => installPython({ root, declared: py.declared, platform: other }), new RegExp(`config/toolchain\\.json pythonBuild declares no sha256 for ${other}; declare the digest of cpython-3\\.14\\.8\\+20261009-${PYTHON_TRIPLES[other].replaceAll('.', '\\.')}-install_only\\.tar\\.gz`));
});

test('pythonBuild of another minor release or a malformed digest is refused before any install', (t) => {
  const py = pythonBuild(t);
  const other = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: { ...py.declared, version: '3.13.2' } }) });
  const otherResult = install(other, toolchainStubs(t).env, 'python');
  assert.equal(otherResult.status, 1);
  assert.match(otherResult.stderr, /config\/toolchain\.json pythonBuild declares 3\.13\.2, but python declares 3\.14; declare a release of 3\.14/);
  const malformed = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: { ...py.declared, sha256: { [py.key]: 'ABC' } } }) });
  const malformedResult = install(malformed, toolchainStubs(t).env, 'python');
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /must record the sha256 of .* as 64 lowercase hexadecimal digits; it records "ABC"/);
  const noMinor = toolchainCheckout(t, { 'config/toolchain.json': config({ pythonBuild: py.declared }) });
  const noMinorResult = install(noMinor, toolchainStubs(t).env, 'python');
  assert.equal(noMinorResult.status, 1);
  assert.match(noMinorResult.stderr, /config\/toolchain\.json pythonBuild needs python, the minor release of the checks/);
});

test('ruff without pythonBuild names the declaration and the install of the Python', (t) => {
  const root = toolchainCheckout(t, {
    'config/toolchain.json': config({ python: '3.14', ruff: { version: '0.16.10', sha256: { 'linux-x64': 'f33f43a864a8483eebd160e713336c8bab02c934feaff0a33cf5ccb41546d09a' } } }),
  });
  const result = install(root, toolchainStubs(t).env, 'ruff');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ruff needs var\/tools\/bin\/python3, the Python that config\/toolchain\.json pythonBuild declares; declare pythonBuild and run make install-tools TOOLS=python/);
});

const LINKS = (directory) => {
  // A file link, a directory link and a link to a link, as python-build-standalone holds them.
  mkdirSync(path.join(directory, 'python/lib/python3.14'), { recursive: true });
  writeFileSync(path.join(directory, 'python/lib/python3.14/os.py'), 'import sys\n');
  symlinkSync('python3.14', path.join(directory, 'python/bin/python3'));
  symlinkSync('python3.14', path.join(directory, 'python/lib/python3'));
  symlinkSync('python3', path.join(directory, 'python/bin/py'));
};
const symlinks = directory => {
  const found = [];
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isSymbolicLink()) found.push(file); else if (entry.isDirectory()) walk(file); } };
  walk(directory);
  return found;
};

test('the links of the archive are replaced by regular copies of their targets, and the installed tree holds no link', (t) => {
  const py = pythonBuild(t, { extra: LINKS });
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: py.declared }) });
  const stubs = toolchainStubs(t, { downloads: { [py.url]: py.archive } });
  const result = install(root, stubs.env, 'python');
  assert.equal(result.status, 0, result.stderr);
  const tree = path.join(root, 'var/tools/python-build/python');
  assert.deepEqual(symlinks(path.join(root, 'var/tools')), [], 'no link in var/tools');
  assert.ok(lstatSync(path.join(tree, 'bin/python3')).isFile(), 'a file link is a regular file');
  assert.equal(readFileSync(path.join(tree, 'bin/python3'), 'utf8'), readFileSync(path.join(tree, 'bin/python3.14'), 'utf8'));
  assert.ok(lstatSync(path.join(tree, 'lib/python3')).isDirectory(), 'a directory link is a directory');
  assert.equal(readFileSync(path.join(tree, 'lib/python3/os.py'), 'utf8'), 'import sys\n');
  assert.equal(readFileSync(path.join(tree, 'bin/py'), 'utf8'), readFileSync(path.join(tree, 'bin/python3.14'), 'utf8'), 'a link to a link is a regular file');
  assert.equal(run(path.join(root, 'var/tools/bin/python3'), stubs.env), 'Python 3.14.8');
  assert.equal(install(root, stubs.env, 'python').status, 0);
  assert.equal(stubs.calls().filter(line => line.startsWith('curl')).length, 1, 'a second run keeps the installed release');
});

const escape = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('a link whose target is missing or outside the archive fails the install and names the link and its target', (t) => {
  // The outside target is this test file, an existing file of another directory.
  for (const [name, target, reason] of [['missing', 'no-such-file', 'is missing or cannot be resolved'], ['outside', fileURLToPath(import.meta.url), 'lies outside the archive python']]) {
    const py = pythonBuild(t, { extra: (directory) => { symlinkSync(target, path.join(directory, 'python/bin/broken')); } });
    const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: py.declared }) });
    const stubs = toolchainStubs(t, { downloads: { [py.url]: py.archive } });
    const result = install(root, stubs.env, 'python');
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, new RegExp(`python/bin/broken links to ${escape(target)}, which ${escape(reason)}`), name);
    assert.deepEqual(readdirSync(path.join(root, 'var/tools')), [], name + ': nothing is installed');
  }
});
