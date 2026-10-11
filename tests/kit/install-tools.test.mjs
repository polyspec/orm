// Tests of scripts/kit/install-tools.mjs: each declared tool is installed into var/tools with PATH stubs (npm, go, python,
// curl), wrappers are executable files and no symbolic link is written, a second run installs nothing, a changed
// declaration replaces the tool, and a failure names the expected and the actual value.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { goToolchainModule } from '../../scripts/kit/install-go.mjs';
import { toolchainCheckout } from './toolchain-checkout.mjs';
import { pythonBuild, ruffWheel, toolchainStubs } from './toolchain-stubs.mjs';

const MODULE = goToolchainModule('1.27.1');
const install = (root, env, ...tools) => spawnSync(process.execPath, ['scripts/kit/install-tools.mjs', ...tools], { cwd: root, env, encoding: 'utf8' });
const config = value => JSON.stringify({ schema: 1, ...value });
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
const noSymlinks = (root) => {
  for (const file of [root, ...walk(root)]) assert.equal(lstatSync(file).isSymbolicLink(), false, `${file} is a symbolic link`);
};
const run = (file, env) => spawnSync(file, ['--version'], { encoding: 'utf8', env }).stdout.trim();

test('npm is installed by the npm of the machine, with wrappers, and a second run installs nothing', (t) => {
  const root = toolchainCheckout(t, { 'package.json': '{ "packageManager": "npm@12.2.0" }' });
  const stubs = toolchainStubs(t);
  const first = install(root, stubs.env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /\[install-tools\] npm: none is installed in var\/tools\/npm; installing 12\.2\.0/);
  assert.match(first.stdout, /\[install-tools\] npm: installed 12\.2\.0 in var\/tools\/npm/);
  assert.equal(stubs.calls().filter(line => line.startsWith('npm install --prefix')).length, 1);
  for (const name of ['npm', 'npx']) {
    const wrapper = path.join(root, 'var/tools/bin', name);
    assert.equal(lstatSync(wrapper).isFile(), true);
    assert.notEqual(statSync(wrapper).mode & 0o111, 0, `${name} is not executable`);
    assert.match(readFileSync(wrapper, 'utf8'), new RegExp(`^#!/bin/sh\\n# ${name} 12\\.2\\.0 of this checkout .*\\nexec node '${path.join(root, 'var/tools/npm/node_modules/npm/bin', `${name}-cli.js`).replaceAll('.', '\\.')}' "\\$@"\\n$`));
  }
  assert.equal(run(path.join(root, 'var/tools/bin/npm'), stubs.env), '12.2.0');
  noSymlinks(path.join(root, 'var/tools'));

  const second = install(root, stubs.env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /npm: 12\.2\.0 is installed in var\/tools\/npm/);
  assert.equal(stubs.calls().filter(line => line.startsWith('npm install')).length, 1, 'a second run starts no install');
  assert.doesNotMatch(second.stdout, /wrote /);
});

test('a changed npm declaration replaces the installed release', (t) => {
  const root = toolchainCheckout(t, { 'package.json': '{ "packageManager": "npm@12.2.0" }' });
  const stubs = toolchainStubs(t);
  assert.equal(install(root, stubs.env).status, 0);
  writeFileSync(path.join(root, 'package.json'), '{ "packageManager": "npm@12.3.1" }');
  const result = install(root, stubs.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm: 12\.2\.0 is installed in var\/tools\/npm; installing 12\.3\.1/);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'var/tools/npm/node_modules/npm/package.json'), 'utf8')).version, '12.3.1');
  assert.equal(run(path.join(root, 'var/tools/bin/npm'), stubs.env), '12.3.1');
  assert.deepEqual(readdirSync(path.join(root, 'var/tools')).sort(), ['bin', 'npm'], 'no temporary or old directory is left');
});

test('the installation of an npm that is not the declared release fails with the expected and the actual release', (t) => {
  const root = toolchainCheckout(t, { 'package.json': '{ "packageManager": "npm@12.2.0" }' });
  const stubs = toolchainStubs(t, { extra: { STUB_NPM_SHOWS: '12.1.0' } });
  const result = install(root, stubs.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the installation of npm 12\.2\.0 into .* prints 12\.1\.0; expected 12\.2\.0/);
  assert.equal(readdirSync(path.join(root, 'var/tools')).filter(name => name !== 'bin').length, 0, 'a failed install leaves nothing');
});

test('the npm bootstrap runs without var/tools/bin on PATH', (t) => {
  const root = toolchainCheckout(t, { 'package.json': '{ "packageManager": "npm@12.2.0" }' });
  const stubs = toolchainStubs(t);
  const log = path.join(stubs.directory, 'path.log');
  const bin = path.join(root, 'var/tools/bin');
  const env = { ...stubs.env, PATH: `${bin}${path.delimiter}${stubs.env.PATH}`, STUB_PATH_LOG: log };
  assert.equal(install(root, env).status, 0);
  assert.equal(readFileSync(log, 'utf8').split('\n')[0].split(path.delimiter).includes(bin), false);
});

// A tarball of an npm release: package/package.json and package/bin/npm-cli.js, as the registry serves it.
function npmTarball(t, root, { version = '12.2.0', link = false } = {}) {
  const source = path.join(root, `tarball-source-${version}${link ? '-link' : ''}`);
  mkdirSync(path.join(source, 'package/bin'), { recursive: true });
  writeFileSync(path.join(source, 'package/package.json'), JSON.stringify({ name: 'npm', version }));
  writeFileSync(path.join(source, 'package/bin/npm-cli.js'), `console.log(${JSON.stringify(version)});\n`);
  writeFileSync(path.join(source, 'package/bin/npx-cli.js'), 'console.log("npx");\n');
  if (link) symlinkSync('/etc/hosts', path.join(source, 'package/bin/link'));
  const file = path.join(root, `npm-${version}${link ? '-link' : ''}.tgz`);
  assert.equal(spawnSync('tar', ['-czf', file, '-C', source, 'package']).status, 0);
  return { file, sha512: createHash('sha512').update(readFileSync(file)).digest('hex'), url: `https://registry.npmjs.org/npm/-/npm-${version}.tgz` };
}

test('npm with a declared digest is downloaded, verified and unpacked without the npm of the machine', (t) => {
  const root = toolchainCheckout(t);
  const tarball = npmTarball(t, root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: `npm@12.2.0+sha512.${tarball.sha512}` }));
  const stubs = toolchainStubs(t, { downloads: { [tarball.url]: tarball.file } });
  const first = install(root, stubs.env);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(stubs.calls().map(line => line.split(' ')[0]), ['curl']);
  assert.equal(readFileSync(path.join(root, 'var/tools/npm/node_modules/npm/.sha512'), 'utf8'), `${tarball.sha512}\n`);
  assert.equal(run(path.join(root, 'var/tools/bin/npm'), stubs.env), '12.2.0');
  noSymlinks(path.join(root, 'var/tools'));
  assert.equal(install(root, stubs.env).status, 0);
  assert.equal(stubs.calls().length, 1, 'a second run downloads nothing');
});

test('npm is reinstalled when its declared digest changes with the same version', (t) => {
  const root = toolchainCheckout(t);
  const tarball = npmTarball(t, root);
  writeFileSync(path.join(root, 'package.json'), '{ "packageManager": "npm@12.2.0" }');
  const stubs = toolchainStubs(t, { downloads: { [tarball.url]: tarball.file } });
  assert.equal(install(root, stubs.env).status, 0);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: `npm@12.2.0+sha512.${tarball.sha512}` }));
  const result = install(root, stubs.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installing 12\.2\.0\+sha512\./);
  assert.equal(stubs.calls().filter(line => line.startsWith('curl')).length, 1);
});

test('a tarball with another digest or with a link is refused', (t) => {
  const root = toolchainCheckout(t);
  const tarball = npmTarball(t, root);
  const wrong = 'b'.repeat(128);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: `npm@12.2.0+sha512.${wrong}` }));
  const stubs = toolchainStubs(t, { downloads: { [tarball.url]: tarball.file } });
  const mismatch = install(root, stubs.env);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, new RegExp(`npm 12\\.2\\.0 tarball https://registry\\.npmjs\\.org/npm/-/npm-12\\.2\\.0\\.tgz has the sha512 ${tarball.sha512}; packageManager of package\\.json declares ${wrong}`));

  const linked = npmTarball(t, root, { link: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: `npm@12.2.0+sha512.${linked.sha512}` }));
  const withLink = toolchainStubs(t, { downloads: { [tarball.url]: linked.file } });
  const refused = install(root, withLink.env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the npm 12\.2\.0 tarball holds a link or a special file; expected files and directories only: l/);
});

test('Go is downloaded as a toolchain module, made executable, wrapped, and kept by a second run', (t) => {
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ go: { mod: 'go.mod' } }), 'go.mod': 'module example.com/fixture\n\ngo 1.27.1\n' });
  const stubs = toolchainStubs(t);
  const first = install(root, stubs.env);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(stubs.calls(), [`go mod download -x ${MODULE}`]);
  const goroot = path.join(root, 'var/tools/go', MODULE);
  assert.notEqual(statSync(path.join(goroot, 'pkg/tool/stub_arch/compile')).mode & 0o111, 0, 'the tool of the module is executable');
  assert.throws(() => lstatSync(path.join(root, 'var/tools/go/cache')), { code: 'ENOENT' });
  for (const name of ['go', 'gofmt']) {
    const wrapper = path.join(root, 'var/tools/bin', name);
    assert.match(readFileSync(wrapper, 'utf8'), new RegExp(`GOTOOLCHAIN=local exec '${path.join(goroot, 'bin', name).replaceAll('.', '\\.')}' "\\$@"`));
    assert.notEqual(statSync(wrapper).mode & 0o111, 0);
  }
  assert.equal(run(path.join(root, 'var/tools/bin/go'), stubs.env), 'go 1.27.1 local');
  noSymlinks(path.join(root, 'var/tools'));

  const second = install(root, stubs.env);
  assert.match(second.stdout, /Go: 1\.27\.1 is installed in var\/tools\/go/);
  assert.equal(stubs.calls().length, 1, 'a second run downloads nothing');
});

test('a changed Go declaration replaces the toolchain and a toolchain of another release fails', (t) => {
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ go: { mod: 'go.mod' } }), 'go.mod': 'module example.com/fixture\n\ngo 1.27.1\n' });
  const stubs = toolchainStubs(t);
  assert.equal(install(root, stubs.env).status, 0);
  writeFileSync(path.join(root, 'go.mod'), 'module example.com/fixture\n\ngo 1.27.2\n');
  assert.equal(install(root, stubs.env).status, 0);
  assert.deepEqual(readdirSync(path.join(root, 'var/tools/go/golang.org')), [goToolchainModule('1.27.2').split('/')[1]], 'only the declared release remains');

  const wrong = toolchainCheckout(t, { 'config/toolchain.json': config({ go: { mod: 'go.mod' } }), 'go.mod': 'module example.com/fixture\n\ngo 1.27.1\n' });
  const result = install(wrong, toolchainStubs(t, { extra: { STUB_GO_SHOWS: '1.26.0' } }).env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the installation of Go 1\.27\.1 into .* prints 1\.26\.0; expected 1\.27\.1/);
});

test('the Go toolchain module names the platform and refuses an unsupported one', () => {
  assert.equal(goToolchainModule('1.27.1', 'linux', 'x64'), 'golang.org/toolchain@v0.0.1-go1.27.1.linux-amd64');
  assert.equal(goToolchainModule('1.27.1', 'darwin', 'arm64'), 'golang.org/toolchain@v0.0.1-go1.27.1.darwin-arm64');
  assert.throws(() => goToolchainModule('1.27.1', 'win32', 'x64'), /no Go toolchain module for the platform win32; the platforms are darwin, linux/);
  assert.throws(() => goToolchainModule('1.27.1', 'linux', 'ia32'), /no Go toolchain module for the architecture ia32; the architectures are x64, arm64/);
});

// The ruff of the declaration: its exact version and the sha256 of its wheel, under the platform key of this machine.
const ruffDigest = version => createHash('sha256').update(ruffWheel(version)).digest('hex');
const ruffConfig = (version = '0.16.10', digest = ruffDigest(version)) => ({ version, sha256: { [`${process.platform}-${process.arch}`]: digest } });
const ruffFiles = py => ({ 'config/toolchain.json': config({ python: '3.14', pythonBuild: py.declared, ruff: ruffConfig() }) });
// The calls of the installs: the version probes of the Python are not installs.
const installCalls = stubs => stubs.calls().filter(line => !line.includes('--version'));
const RUFF_WHEEL = version => path.join('var/tools/wheels', `ruff-${version}-py3-none-any.whl`);

test('ruff is downloaded with its sha256 checked, installed into a virtual environment of var/tools/bin/python3 and kept by a second run', (t) => {
  const py = pythonBuild(t);
  const root = toolchainCheckout(t, ruffFiles(py));
  const stubs = toolchainStubs(t, { downloads: { [py.url]: py.archive } });
  const first = install(root, stubs.env);
  assert.equal(first.status, 0, first.stderr);
  const calls = installCalls(stubs);
  assert.match(calls.find(line => line.startsWith('python3.14 -m venv')), /^python3\.14 -m venv --copies .*var\/tools\/python\.next-/);
  assert.match(calls.find(line => line.includes(' pip download ')), /^python3\.14 -m pip download --no-deps .*--only-binary :all: --require-hashes -r .* -d .*var\/tools\/wheels$/);
  assert.equal(calls.find(line => line.startsWith('venv-python')), `venv-python -m pip install --quiet --no-index --no-deps ${path.join(root, RUFF_WHEEL('0.16.10'))}`);
  assert.equal(run(path.join(root, 'var/tools/bin/ruff'), stubs.env), 'ruff 0.16.10');
  noSymlinks(path.join(root, 'var/tools'));
  assert.equal(install(root, stubs.env).status, 0);
  assert.equal(installCalls(stubs).length, calls.length, 'a second run starts no install');

  writeFileSync(path.join(root, 'config/toolchain.json'), config({ python: '3.14', pythonBuild: py.declared, ruff: ruffConfig('0.17.0') }));
  assert.equal(install(root, stubs.env).status, 0);
  assert.equal(run(path.join(root, 'var/tools/bin/ruff'), stubs.env), 'ruff 0.17.0');
});

test('a ruff wheel whose sha256 is not declared is removed, and the failure names both digests', (t) => {
  const py = pythonBuild(t);
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', pythonBuild: py.declared, ruff: ruffConfig('0.16.10', '0'.repeat(64)) }) });
  const result = install(root, toolchainStubs(t, { downloads: { [py.url]: py.archive } }).env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${RUFF_WHEEL('0.16.10').replaceAll('.', '\\.')} has the sha256 ${ruffDigest('0.16.10')}, config/toolchain\\.json ruff declares ${'0'.repeat(64)}; the file is removed`));
  assert.equal(existsSync(path.join(root, RUFF_WHEEL('0.16.10'))), false);
  assert.equal(existsSync(path.join(root, 'var/tools/python')), false, 'no environment is made');
});

test('ruff of another release than its installation prints fails with the expected and the actual release', (t) => {
  const py = pythonBuild(t);
  const root = toolchainCheckout(t, ruffFiles(py));
  const wrong = install(root, toolchainStubs(t, { downloads: { [py.url]: py.archive }, extra: { STUB_RUFF_SHOWS: '0.15.0' } }).env);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /the installation of ruff 0\.16\.10 into .* prints 0\.15\.0; expected 0\.16\.10/);
});

test('ruff without pythonBuild names the declaration and the install of the Python', (t) => {
  const root = toolchainCheckout(t, { 'config/toolchain.json': config({ python: '3.14', ruff: ruffConfig() }) });
  const result = install(root, toolchainStubs(t).env, 'ruff');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ruff needs var\/tools\/bin\/python3, the Python that config\/toolchain\.json pythonBuild declares; declare pythonBuild and run make install-tools TOOLS=python/);
});

test('Composer with a digest is downloaded, verified, wrapped and kept; one without a digest is not installed', (t) => {
  const root = toolchainCheckout(t);
  const phar = path.join(root, 'composer.phar.source');
  writeFileSync(phar, '<?php echo "composer";\n');
  const sha256 = createHash('sha256').update(readFileSync(phar)).digest('hex');
  const url = 'https://getcomposer.org/download/2.10.3/composer.phar';
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config/toolchain.json'), config({ composer: { version: '2.10.3', sha256 } }));
  const stubs = toolchainStubs(t, { downloads: { [url]: phar } });
  const first = install(root, stubs.env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(path.join(root, 'var/tools/composer/composer.phar'), 'utf8'), '<?php echo "composer";\n');
  assert.match(readFileSync(path.join(root, 'var/tools/bin/composer'), 'utf8'), new RegExp(`exec php '${path.join(root, 'var/tools/composer/composer.phar').replaceAll('.', '\\.')}' "\\$@"`));
  noSymlinks(path.join(root, 'var/tools'));
  assert.equal(install(root, stubs.env).status, 0);
  assert.equal(stubs.calls().length, 1, 'a second run downloads nothing');

  writeFileSync(path.join(root, 'config/toolchain.json'), config({ composer: { version: '2.10.3', sha256: 'c'.repeat(64) } }));
  const mismatch = install(root, stubs.env);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, new RegExp(`${url.replaceAll('.', '\\.')} has the sha256 ${sha256}; config/toolchain\\.json composer declares ${'c'.repeat(64)}`));

  const verified = toolchainCheckout(t, { 'config/toolchain.json': config({ composer: { version: '2.10.3' } }) });
  const quiet = toolchainStubs(t);
  assert.equal(install(verified, quiet.env).status, 0);
  assert.deepEqual(quiet.calls(), [], 'a Composer without a digest is verified, not installed');
});

test('only the declared tools are installed and a repository that declares none installs nothing', (t) => {
  const root = toolchainCheckout(t, { '.node-version': '26.8.1\n', 'rust-toolchain.toml': '[toolchain]\nchannel = "1.98.1"\n', 'config/toolchain.json': config({ php: ['8.5'] }) });
  const stubs = toolchainStubs(t);
  const result = install(root, stubs.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(stubs.calls(), []);
});

test('the named tools are installed alone, and an unknown or an undeclared name fails before any install', (t) => {
  const root = toolchainCheckout(t, {
    'package.json': '{ "packageManager": "npm@12.2.0" }',
    'config/toolchain.json': config({ python: '3.14', ruff: ruffConfig() }),
  });
  const stubs = toolchainStubs(t);
  const named = install(root, stubs.env, 'npm');
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(readdirSync(path.join(root, 'var/tools/bin')).sort(), ['npm', 'npx']);
  assert.ok(stubs.calls().every(line => !line.startsWith('python3.14')), 'ruff was not installed');
  const unknown = install(root, stubs.env, 'make');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown tool make; the tools are python, pythonBackend, npm, go, ruff, composer, cargoAudit, govulncheck/);
  const undeclared = install(root, stubs.env, 'go');
  assert.equal(undeclared.status, 1);
  assert.match(undeclared.stderr, /go is not declared; declare it in config\/toolchain\.json or in its file, or leave it out of the tools to install/);
});

test('an undeclared or malformed declaration fails before any install', (t) => {
  const root = toolchainCheckout(t, { 'package.json': '{ "packageManager": "yarn@4.0.0" }', 'config/toolchain.json': config({ go: { mod: 'go.mod' } }), 'go.mod': 'go 1.27.1\n' });
  const stubs = toolchainStubs(t);
  const result = install(root, stubs.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[install-tools\] package\.json packageManager is "yarn@4\.0\.0", expected npm@/);
  assert.deepEqual(stubs.calls(), []);
});

const AUDIT_FILES = { 'config/toolchain.json': config({ cargoAudit: '0.22.2', govulncheck: '1.1.4' }) };

test('cargo-audit and govulncheck are installed by their own installers and kept by a second run', (t) => {
  const root = toolchainCheckout(t, AUDIT_FILES);
  const stubs = toolchainStubs(t);
  const first = install(root, stubs.env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /cargo-audit: installed 0\.22\.2 in var\/tools\/cargo-audit/);
  assert.match(first.stdout, /govulncheck: installed 1\.1\.4 in var\/tools\/govulncheck/);
  assert.match(stubs.calls()[0], /^cargo install --locked --root .*var\/tools\/cargo-audit\.next-.* cargo-audit@0\.22\.2$/);
  assert.equal(stubs.calls()[1], 'go install golang.org/x/vuln/cmd/govulncheck@v1.1.4');
  assert.equal(run(path.join(root, 'var/tools/cargo-audit/bin/cargo-audit'), stubs.env), 'cargo-audit 0.22.2');
  noSymlinks(path.join(root, 'var/tools'));
  assert.equal(install(root, stubs.env).status, 0);
  assert.equal(stubs.calls().length, 2, 'a second run builds nothing');

  writeFileSync(path.join(root, 'config/toolchain.json'), config({ cargoAudit: '0.22.3', govulncheck: '1.1.5' }));
  assert.equal(install(root, stubs.env).status, 0);
  assert.equal(stubs.calls().length, 4);
  assert.equal(run(path.join(root, 'var/tools/cargo-audit/bin/cargo-audit'), stubs.env), 'cargo-audit 0.22.3');
});

test('an audit tool that prints another release fails with the expected and the actual release', (t) => {
  const root = toolchainCheckout(t, AUDIT_FILES);
  const result = install(root, toolchainStubs(t, { extra: { STUB_CARGO_AUDIT_SHOWS: '0.21.0' } }).env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the installation of cargo-audit 0\.22\.2 into .* prints 0\.21\.0; expected 0\.22\.2/);
});

test('every declared tool is installed in the order npm, Go, Python, ruff, Composer, cargo-audit, govulncheck', (t) => {
  const phar = path.join(toolchainCheckout(t), 'phar');
  writeFileSync(phar, 'phar');
  const sha256 = createHash('sha256').update('phar').digest('hex');
  const py = pythonBuild(t);
  const root = toolchainCheckout(t, {
    'package.json': '{ "packageManager": "npm@12.2.0" }',
    'go.mod': 'module example.com/fixture\n\ngo 1.27.1\n',
    'config/toolchain.json': config({ python: '3.14', pythonBuild: py.declared, go: { mod: 'go.mod' }, ruff: ruffConfig(), composer: { version: '2.10.3', sha256 }, cargoAudit: '0.22.2', govulncheck: '1.1.4' }),
  });
  const stubs = toolchainStubs(t, { downloads: { 'https://getcomposer.org/download/2.10.3/composer.phar': phar, [py.url]: py.archive } });
  const result = install(root, stubs.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(line => /: installed /.test(line)).map(line => line.split(':')[0].replace('[install-tools] ', '')), ['npm', 'Go', 'Python', 'ruff', 'Composer', 'cargo-audit', 'govulncheck']);
  assert.deepEqual(readdirSync(path.join(root, 'var/tools/bin')).sort(), ['composer', 'go', 'gofmt', 'npm', 'npx', 'python3', 'ruff']);
  const calls = installCalls(stubs).length;
  const again = install(root, stubs.env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(installCalls(stubs).length, calls, 'a second run starts no install command');
  assert.doesNotMatch(again.stdout, /: installed /);
});

test('the make target install-tools runs the tool, online through ONLINE', () => {
  const dry = spawnSync('make', ['-n', '--no-print-directory', '-f', 'scripts/kit/kit.mk', 'install-tools', 'ONLINE=online-wrapper'], { cwd: path.join(path.dirname(new URL(import.meta.url).pathname), '../..'), encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout.trim(), 'online-wrapper node scripts/kit/install-tools.mjs');
});
