// Tests of the consumer install (scripts/kit/release-consumer.mjs): the configuration rules, the lock, the install in clean
// projects outside the repository and each failure. The sandbox stubs npm and Composer on PATH (release-consumer-sandbox.mjs);
// the last case runs the real npm and Composer against archives that the release tool builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { checkConfig } from '../../scripts/kit/kit-check.mjs';
import * as release from '../../scripts/kit/release.mjs';
import { Stop, run } from '../../scripts/kit/process.mjs';
import * as consumer from '../../scripts/kit/release-consumer.mjs';
import { git, readJson, releaseSandbox, writeJson } from './release-sandbox.mjs';
import { consumerSandbox } from './release-consumer-sandbox.mjs';

const stop = (fn, pattern) => assert.throws(fn, error => error instanceof Stop && pattern.test(error.message), String(pattern));
const NPM = 'tests/release-consumer/npm';
const COMPOSER = 'tests/release-consumer/composer';
const edit = (root, file, change) => writeJson(root, file, change(readJson(root, file)));
const install = (box, version = box.version, directory = path.join(box.root, release.ASSETS)) => consumer.installConsumers(box.ctx(), version, directory);

test('the schema accepts the consumers of the fixture and names each error of another', (t) => {
  const box = releaseSandbox(t);
  assert.deepEqual(checkConfig(box.root).filter(line => line.startsWith('config/release.json')), []);
  edit(box.root, 'config/release.json', config => ({ ...config, consumers: { npm: { directory: '/abs', smoke: {} }, pip: {} }, proof: {} }));
  const findings = checkConfig(box.root).filter(line => line.startsWith('config/release.json')).join('\n');
  assert.match(findings, /\$\.consumers\.npm\.directory is "\/abs"/);
  assert.match(findings, /\$\.consumers\.pip is not in the schema/);
  assert.match(findings, /\$\.proof lacks gitTag/);
});

test('the configuration rules name each inconsistent consumer and proof entry', (t) => {
  const box = releaseSandbox(t);
  const original = readJson(box.root, 'config/release.json');
  const load = (change) => {
    writeJson(box.root, 'config/release.json', change(structuredClone(original)));
    return () => release.loadConfig(box.root);
  };
  assert.equal(release.loadConfig(box.root).consumers.npm.directory, NPM);
  stop(load(c => ({ ...c, consumers: { npm: c.consumers.npm } })), /consumers\.composer is missing; the composer packages \[polyspec\/kit-fixture\] need a consumer project/);
  stop(load((c) => { c.consumers.npm.smoke.nothing = ['node']; return c; }), /consumers\.npm\.smoke\.nothing is not a npm package of packages \[fixture-lib, fixture-app\]/);
  stop(load((c) => { c.consumers.npm.smoke['fixture-lib'] = []; return c; }), /consumers\.npm\.smoke\.fixture-lib needs a command, a non-empty array of non-empty strings, found \[\]/);
  stop(load((c) => { c.consumers.npm.smoke['fixture-lib'] = 'node -e 1'; return c; }), /consumers\.npm\.smoke\.fixture-lib needs a command.*found "node -e 1"/);
  stop(load((c) => { c.consumers.npm.smoke = {}; return c; }), /consumers\.npm\.smoke needs one entry per installed package/);
  stop(load((c) => { c.consumers.composer.directory = c.consumers.npm.directory; return c; }), /consumers\.composer\.directory tests\/release-consumer\/npm is also the directory of another consumer/);
  stop(load(c => ({ ...c, packages: c.packages.filter(item => item.kind === 'npm'), manifests: Object.fromEntries(Object.entries(c.manifests).filter(([file]) => !file.endsWith('composer.json'))) })), /consumers\.composer is set but packages lists no composer package/);
  delete original.proof.gitTag['packages/fixture-rust/Cargo.toml'];
  stop(load(c => c), /proof\.gitTag lacks packages\/fixture-rust\/Cargo\.toml, which manifests releases by "git-tag"/);
  stop(load((c) => { c.proof.gitTag['packages/fixture-lib/package.json'] = { kind: 'python', name: 'x', smoke: ['python'] }; return c; }), /proof\.gitTag\.packages\/fixture-lib\/package\.json is not a manifest with the mode "git-tag"/);
  stop(load((c) => { c.proof.gitTag['packages/fixture-python/pyproject.toml'].kind = 'rust'; return c; }), /kind rust installs a Cargo\.toml, not a pyproject\.toml/);
  stop(load((c) => { c.proof.gitTag['packages/fixture-python/pyproject.toml'].kind = 'ruby'; return c; }), /kind is "ruby", the allowed values are python, rust/);
  stop(load((c) => { c.proof.gitTag['packages/fixture-python/pyproject.toml'].name = ''; return c; }), /\.name needs the package name/);
  stop(load((c) => { c.proof.gitTag['packages/fixture-python/pyproject.toml'].smoke = [1]; return c; }), /\.smoke needs a command/);
});

test('lock writes the manifests and locks of the archives of the tag, without the hashes of the archives, and a second run changes nothing', (t) => {
  const box = consumerSandbox(t);
  const written = box.lock();
  assert.deepEqual(written, [`${NPM}/package.json`, `${NPM}/package-lock.json`, `${COMPOSER}/composer.json`, `${COMPOSER}/composer.lock`]);
  assert.deepEqual(readJson(box.root, `${NPM}/package.json`), { name: 'kit-fixture-consumer', private: true, dependencies: { 'fixture-lib': 'file:fixture-lib-npm-0.0.1.tgz', 'fixture-app': 'file:fixture-app-npm-0.0.1.tgz' } });
  const composer = readJson(box.root, `${COMPOSER}/composer.json`);
  assert.deepEqual(composer.require, { 'polyspec/kit-fixture': '0.0.1' });
  assert.deepEqual(composer.repositories, [{ type: 'artifact', url: 'artifacts' }, { 'packagist.org': false }]);
  const lock = readJson(box.root, `${NPM}/package-lock.json`).packages;
  assert.deepEqual([lock['node_modules/fixture-lib'].integrity, lock['node_modules/fixture-app'].integrity], [undefined, undefined], 'the archives are built in the run that uses them');
  assert.equal(lock['node_modules/fixture-lib'].resolved, 'file:fixture-lib-npm-0.0.1.tgz');
  assert.equal(lock['node_modules/semver'].integrity, 'sha512-third-party', 'a registry package keeps its integrity');
  assert.deepEqual(readJson(box.root, `${COMPOSER}/composer.lock`).packages.map(entry => [entry.name, entry.version, entry.dist.url, entry.dist.shasum]), [['polyspec/kit-fixture', '0.0.1', 'artifacts/polyspec-kit-fixture-php-0.0.1.zip', '']]);
  const before = written.map(file => readFileSync(path.join(box.root, file), 'utf8'));
  box.lock();
  assert.deepEqual(written.map(file => readFileSync(path.join(box.root, file), 'utf8')), before);
  assert.deepEqual(existsSync(path.join(box.root, `${NPM}/package-lock.json.next-${process.pid}`)), false, 'the temporary file is renamed');
});

test('lock runs npm and Composer from clean projects outside the repository without the offline settings', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  const [npm] = box.calls('npm');
  const [composer] = box.calls('composer');
  assert.deepEqual(npm.args, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0']);
  assert.deepEqual(composer.args, ['update', '--no-install', '--no-interaction', '--no-progress', '--no-plugins', '--no-scripts']);
  for (const call of [npm, composer]) {
    assert.ok(path.relative(realpathSync(box.root), call.cwd).startsWith('..'), `${call.tool} ran in ${call.cwd}, inside ${box.root}`);
    assert.equal(call.env.npm_config_offline, null);
    assert.equal(call.env.COMPOSER_DISABLE_NETWORK, null);
  }
  const folder = call => path.basename(path.dirname(call.cwd));
  assert.deepEqual([path.basename(path.dirname(npm.env.npm_config_cache)), path.basename(path.dirname(composer.env.COMPOSER_HOME))], [folder(npm), folder(composer)], 'the caches are directories of the run');
  assert.ok(!existsSync(npm.cwd), 'the project is removed after the run');
});

test('lock needs the archives of the tag and a committed manifest', (t) => {
  const box = consumerSandbox(t);
  const tag = box.tag('v0.0.2');
  stop(() => consumer.lockConsumers(box.ctx(), tag), /var\/release\/assets holds \[.*0\.0\.1.*\], the archives of 0\.0\.2 are \[fixture-app-npm-0\.0\.2\.tgz, fixture-lib-npm-0\.0\.2\.tgz, polyspec-kit-fixture-php-0\.0\.2\.zip\]/);
  stop(() => consumer.lockConsumers(box.ctx(), 'packages/fixture-go/v0.0.1'), /packages\/fixture-go\/v0\.0\.1 is a Go module tag/);
  git(box.root, 'rm', '--quiet', '-f', '--', `${NPM}/package.json`);
  stop(() => box.lock(), /tests\/release-consumer\/npm\/package\.json is missing; commit the manifest of the npm consumer project/);
});

test('install runs npm ci and composer install in clean projects outside the repository and the smoke command of every package', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  const steps = [];
  const count = consumer.installConsumers(box.ctx(), box.version, path.join(box.root, release.ASSETS), text => steps.push(text));
  assert.equal(count, 3);
  assert.deepEqual(steps, [
    'npm ci of 2 packages from tests/release-consumer/npm',
    "npm fixture-lib 0.0.1: node -e require('fixture-lib/package.json')",
    "npm fixture-app 0.0.1: node -e require('fixture-app/package.json')",
    'composer install of 1 packages from tests/release-consumer/composer',
    "composer polyspec/kit-fixture 0.0.1: node -e require('./vendor/composer/installed.json')",
  ]);
  const [ci] = box.calls('npm').slice(-1);
  assert.deepEqual(ci.args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0']);
  const [composer] = box.calls('composer').slice(-1);
  assert.deepEqual(composer.args, ['install', '--no-interaction', '--no-progress', '--no-plugins', '--no-scripts']);
  for (const call of [ci, composer]) {
    assert.ok(path.relative(realpathSync(box.root), call.cwd).startsWith('..'), `${call.tool} ran in ${call.cwd}, inside ${box.root}`);
    assert.equal(call.env.npm_config_offline, null, 'the offline setting of the recipe is removed');
    assert.equal(call.env.COMPOSER_DISABLE_NETWORK, null);
  }
  assert.ok(!existsSync(ci.cwd), 'the projects are removed after the run');
});

test('install points the scope of an npm package of the repository at an unreachable registry', (t) => {
  const box = consumerSandbox(t, {
    mutate(root) {
      edit(root, 'config/release.json', (config) => {
        config.packages[0].name = '@kit/fixture-lib';
        const { 'fixture-lib': _, ...rest } = config.consumers.npm.smoke;
        config.consumers.npm.smoke = { '@kit/fixture-lib': ['node', '-e', "require('@kit/fixture-lib/package.json')"], ...rest };
        return config;
      });
      edit(root, 'packages/fixture-lib/package.json', manifest => ({ ...manifest, name: '@kit/fixture-lib' }));
      edit(root, 'packages/fixture-app/package.json', manifest => ({ ...manifest, dependencies: { '@kit/fixture-lib': '0.0.1' } }));
    },
  });
  assert.deepEqual(box.names, ['kit-fixture-lib-npm-0.0.1.tgz', 'fixture-app-npm-0.0.1.tgz', 'polyspec-kit-fixture-php-0.0.1.zip']);
  box.lock();
  install(box);
  assert.deepEqual(box.calls('npm').map(call => call.args.filter(arg => arg.includes('registry'))), [['--@kit:registry=http://127.0.0.1:9/'], ['--@kit:registry=http://127.0.0.1:9/']]);
});

test('install refuses archives other than the archives of the version', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  stop(() => install(box, '0.0.2'), /var\/release\/assets holds \[.*\], the archives of 0\.0\.2 are \[/);
  stop(() => install(box, '0.0.1', path.join(box.root, 'var/other')), /var\/other holds \[\], the archives of 0\.0\.1 are \[/);
});

test('install names each difference of the manifests and locks from the archives', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  edit(box.root, `${NPM}/package.json`, manifest => ({ ...manifest, dependencies: { ...manifest.dependencies, 'fixture-lib': 'file:fixture-lib-npm-0.0.0.tgz' } }));
  edit(box.root, `${NPM}/package-lock.json`, (lock) => { lock.packages['node_modules/fixture-app'].version = '0.0.0'; return lock; });
  edit(box.root, `${COMPOSER}/composer.json`, manifest => ({ ...manifest, require: { 'polyspec/kit-fixture': '0.0.0' }, repositories: [] }));
  edit(box.root, `${COMPOSER}/composer.lock`, (lock) => { lock.packages[0].dist.url = 'artifacts/polyspec-kit-fixture-php-0.0.0.zip'; return lock; });
  stop(install.bind(null, box), /dependencies\.fixture-lib is "file:fixture-lib-npm-0\.0\.0\.tgz", expected "file:fixture-lib-npm-0\.0\.1\.tgz"/);
  stop(install.bind(null, box), /node_modules\/fixture-app is 0\.0\.0 resolved file:fixture-app-npm-0\.0\.1\.tgz, expected 0\.0\.1 resolved file:fixture-app-npm-0\.0\.1\.tgz/);
  stop(install.bind(null, box), /require\.polyspec\/kit-fixture is "0\.0\.0", expected "0\.0\.1"/);
  stop(install.bind(null, box), /polyspec\/kit-fixture is 0\.0\.1 from artifacts\/polyspec-kit-fixture-php-0\.0\.0\.zip, expected 0\.0\.1 from artifacts\/polyspec-kit-fixture-php-0\.0\.1\.zip/);
  stop(install.bind(null, box), /repositories lacks \{ "type": "artifact", "url": "artifacts" \}/);
  stop(install.bind(null, box), /Fix: make release-consumer-lock TAG=v0\.0\.1 writes them/);
  assert.deepEqual(box.calls('npm').slice(-1).map(call => call.args[0]), ['install'], 'no install ran');
});

test('install fails for a missing lock', (t) => {
  const box = consumerSandbox(t);
  stop(() => install(box), /tests\/release-consumer\/npm\/package-lock\.json is missing; tests\/release-consumer\/composer\/composer\.lock is missing/);
});

test('install names the command, the status and the error of a failed npm ci and composer install', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  box.stub({ modes: { npm: 'fail' } });
  stop(() => install(box), /npm ci --ignore-scripts .* exited with 1: npm stub: ci failed/);
  box.stub({ modes: { npm: '', composer: 'fail' } });
  stop(() => install(box), /composer install --no-interaction .* exited with 1: composer stub: install failed/);
});

test('install fails when a package is installed at another version', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  box.stub({ modes: { npm: 'wrong-version' } });
  stop(() => install(box), /npm installed fixture-lib 9\.9\.9, expected 0\.0\.1/);
  box.stub({ modes: { npm: '', composer: 'wrong-version' } });
  stop(() => install(box), /composer installed polyspec\/kit-fixture 9\.9\.9, expected 0\.0\.1/);
});

test('install fails when a smoke command fails and names the package and the command', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  edit(box.root, 'config/release.json', (config) => { config.consumers.npm.smoke['fixture-app'] = ['node', '-e', "require('fixture-missing/package.json')"]; return config; });
  stop(() => install(box), /node -e require\('fixture-missing\/package\.json'\) exited with 1: .*Cannot find module 'fixture-missing\/package\.json'/s);
});

test('install fails for a smoke command that does not exist', (t) => {
  const box = consumerSandbox(t);
  box.lock();
  edit(box.root, 'config/release.json', (config) => { config.consumers.composer.smoke['polyspec/kit-fixture'] = ['kit-no-such-tool', '--check']; return config; });
  stop(() => install(box), /kit-no-such-tool --check could not start: spawnSync kit-no-such-tool ENOENT/);
});

test('install needs a consumers section', (t) => {
  const box = consumerSandbox(t);
  edit(box.root, 'config/release.json', ({ consumers, ...config }) => config);
  stop(() => install(box), /config\/release\.json has no consumers section/);
});

test('the command line locks, installs, ends a Go module tag without an install and refuses other arguments', (t) => {
  const box = consumerSandbox(t);
  const lines = [];
  const errors = [];
  const run = argv => consumer.main(argv, { root: box.root, env: box.env, print: line => lines.push(line), error: line => errors.push(line) });
  assert.equal(run(['lock', 'v0.0.1']), 0);
  assert.deepEqual(lines, [`[release-consumer] v0.0.1: wrote ${NPM}/package.json and package-lock.json for v0.0.1`, `[release-consumer] v0.0.1: wrote ${COMPOSER}/composer.json and composer.lock for v0.0.1`]);
  lines.length = 0;
  assert.equal(run(['install', 'v0.0.1']), 0);
  assert.equal(lines.at(-1), '[release-consumer] v0.0.1: installed and checked 3 packages from var/release/assets');
  assert.equal(lines.length, 6);
  lines.length = 0;
  assert.equal(run(['install', 'packages/fixture-go/v0.0.1']), 0);
  assert.deepEqual(lines, ['[release-consumer] packages/fixture-go/v0.0.1: a Go module tag releases no archive; nothing to install']);
  assert.equal(run(['install', 'v0.0.2']), 1);
  assert.match(errors.at(-1), /^\[release-consumer\] install v0\.0\.2 failed: var\/release\/assets holds \[/);
  for (const argv of [[], ['install'], ['verify', 'v0.0.1'], ['install', 'v0.0.1', 'x']]) assert.equal(run(argv), 2);
  assert.equal(errors.at(-1), 'usage: node scripts/kit/release-consumer.mjs install|lock TAG');
});

test('make release-consumer-lock and release-consumer take the tag of the environment', (t) => {
  const box = consumerSandbox(t);
  const make = (...args) => spawnSync('make', ['-f', 'scripts/kit/kit.mk', ...args], { cwd: box.root, env: box.env, encoding: 'utf8' });
  for (const target of ['release-consumer', 'release-consumer-lock']) {
    const without = make(target);
    assert.equal(without.status, 2);
    assert.match(without.stdout + without.stderr, new RegExp(`${target}: TAG is required, for example make ${target} TAG=v0\\.0\\.1`));
  }
  const locked = make('release-consumer-lock', 'TAG=v0.0.1');
  assert.equal(locked.status, 0, locked.stderr);
  const installed = make('release-consumer', 'TAG=v0.0.1');
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /installed and checked 3 packages from var\/release\/assets/);
});

// The real npm and Composer install archives that the release tool builds from a committed tree. The tools are required:
// a machine without one fails the case, which names it.
test('the real npm ci and composer install install the archives of a tag from the locks that lock writes', (t) => {
  for (const tool of ['npm', 'composer', 'git', 'unzip', 'tar']) {
    const found = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', tool], { encoding: 'utf8' });
    assert.equal(found.status, 0, `${tool} is required by this case and is not on PATH`);
  }
  // The packages of the fixture without a registry dependency, so that nothing is downloaded.
  const box = releaseSandbox(t, {
    mutate(root) {
      edit(root, 'packages/fixture-lib/package.json', ({ dependencies, ...manifest }) => manifest);
      edit(root, 'packages/fixture-php/composer.json', ({ require, config, ...manifest }) => manifest);
    },
  });
  const tag = box.release('0.0.1');
  const env = { ...process.env, GITHUB_REPOSITORY: 'example/kit-fixture' };
  const ctx = release.context(box.root, { env });
  assert.equal(release.assets(ctx, tag).length, 3);
  consumer.lockConsumers(ctx, tag);
  assert.equal(readJson(box.root, `${NPM}/package-lock.json`).packages['node_modules/fixture-app'].resolved, 'file:fixture-app-npm-0.0.1.tgz');
  assert.equal(readJson(box.root, `${COMPOSER}/composer.lock`).packages[0].dist.url, 'artifacts/polyspec-kit-fixture-php-0.0.1.zip');
  const steps = [];
  assert.equal(consumer.installConsumers(ctx, '0.0.1', path.join(box.root, release.ASSETS), text => steps.push(text)), 3);
  assert.equal(steps.length, 5);
  // The lock changes only with a version: locking again writes the same bytes.
  const before = readFileSync(path.join(box.root, `${NPM}/package-lock.json`), 'utf8');
  consumer.lockConsumers(ctx, tag);
  assert.equal(readFileSync(path.join(box.root, `${NPM}/package-lock.json`), 'utf8'), before);
});
