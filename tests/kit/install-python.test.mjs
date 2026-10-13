// Tests of scripts/kit/install-python.mjs and its install-tools step: the Python of pythonBuild is installed by the uv of the
// checkout (`uv python install --no-bin`) into var/tools/uv-python, found with `uv python find`, wrapped as var/tools/bin/python3,
// and kept by a second run. uv is the stub of a release archive (toolchain-stubs.mjs); no test reaches the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { installPython } from '../../scripts/kit/install-python.mjs';
import { toolchainCheckout } from './toolchain-checkout.mjs';
import { toolchainStubs, uvRelease } from './toolchain-stubs.mjs';

const config = value => JSON.stringify({ schema: 1, ...value });
const install = (root, env, ...tools) => spawnSync(process.execPath, ['scripts/kit/install-tools.mjs', ...tools], { cwd: root, env, encoding: 'utf8' });
const run = (file, env) => spawnSync(file, ['--version'], { encoding: 'utf8', env }).stdout.trim();
const uvCalls = stubs => stubs.calls().filter(line => line.startsWith('uv ') && !line.includes('--version'));

test('the declared Python is installed by uv, wrapped as var/tools/bin/python3, and a second run keeps it', (t) => {
  const uv = uvRelease(t);
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: { version: '3.14.8' }, uv: uv.declared }) });
  const stubs = toolchainStubs(t, { downloads: { [uv.url]: uv.archive } });
  const first = install(root, stubs.env, 'uv', 'python');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /\[install-tools\] Python: none is installed in var\/tools\/uv-python; installing 3\.14\.8/);
  assert.match(first.stdout, /\[install-tools\] Python: installed 3\.14\.8 in var\/tools\/uv-python/);
  assert.deepEqual(uvCalls(stubs), [
    'uv python find --managed-python --no-project 3.14.8',
    'uv python install --no-bin 3.14.8',
    'uv python find --managed-python --no-project 3.14.8',
  ]);
  const interpreter = path.join(root, 'var/tools/uv-python/cpython-3.14.8-stub/bin/python3.14');
  assert.match(readFileSync(path.join(root, 'var/tools/bin/python3'), 'utf8'), new RegExp(`exec '${interpreter.replaceAll('.', '\\.')}' "\\$@"`));
  assert.equal(run(path.join(root, 'var/tools/bin/python3'), stubs.env), 'Python 3.14.8');
  const second = install(root, stubs.env, 'uv', 'python');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Python: 3\.14\.8 is installed in var\/tools\/uv-python/);
  assert.equal(uvCalls(stubs).filter(line => line.includes('python install')).length, 1, 'a second run installs nothing');
});

test('a Python whose release differs from the declaration fails with both releases', (t) => {
  const uv = uvRelease(t);
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: { version: '3.14.8' }, uv: uv.declared }) });
  const result = install(root, toolchainStubs(t, { downloads: { [uv.url]: uv.archive }, extra: { STUB_PYTHON_SHOWS: '3.14.7' } }).env, 'uv', 'python');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the installation of Python 3\.14\.8 by var\/tools\/bin\/uv prints 3\.14\.7; expected 3\.14\.8/);
});

test('Python without the installed uv names the install of uv', (t) => {
  const root = toolchainCheckout(t);
  assert.throws(() => installPython({ root, declared: { version: '3.14.8' } }), /Python needs var\/tools\/bin\/uv, which installs it; declare uv in config\/toolchain\.json and run make install-tools TOOLS=uv/);
});

test('pythonBuild of another minor release, without python or without uv is refused before any install', (t) => {
  const uv = uvRelease(t);
  const other = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: { version: '3.13.2' }, uv: uv.declared }) });
  const otherResult = install(other, toolchainStubs(t).env, 'python');
  assert.equal(otherResult.status, 1);
  assert.match(otherResult.stderr, /config\/toolchain\.json pythonBuild declares 3\.13\.2, but python declares 3\.14; declare a release of 3\.14/);
  const noUv = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: { version: '3.14.8' } }) });
  const noUvResult = install(noUv, toolchainStubs(t).env, 'python');
  assert.equal(noUvResult.status, 1);
  assert.match(noUvResult.stderr, /config\/toolchain\.json pythonBuild needs uv, which installs the Python; declare uv in config\/toolchain\.json/);
  const noMinor = toolchainCheckout(t, { 'config/toolchain.json': config({ pythonBuild: { version: '3.14.8' }, uv: uv.declared }) });
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
