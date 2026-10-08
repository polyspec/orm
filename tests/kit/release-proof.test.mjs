// Tests of the release proof (scripts/kit/release-proof.mjs): each step of the proof has a case that passes and a case that
// fails with the expected and the actual value. The sandbox stubs gh, npm, Composer, Python, cargo and go on PATH
// (release-consumer-sandbox.mjs); git runs for real against the sandbox, which stands in for the remote of the repository URL.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as release from '../../scripts/kit/release.mjs';
import { Stop, run } from '../../scripts/kit/process.mjs';
import * as proof from '../../scripts/kit/release-proof.mjs';
import { git, readJson, writeJson } from './release-sandbox.mjs';
import { consumerSandbox } from './release-consumer-sandbox.mjs';

const stop = (fn, pattern) => assert.throws(fn, error => error instanceof Stop && pattern.test(error.message), String(pattern));
const REMOTE = 'example.com/polyspec/kit-fixture';
const URL = `https://${REMOTE}`;

/** A sandbox whose consumer projects are locked, as the commit of a release holds them. */
function locked(t, options) {
  const box = consumerSandbox(t, options);
  box.lock();
  return box;
}
const installs = box => box.calls('npm').filter(call => call.args[0] === 'ci');
const prove = (box, tag = box.released) => {
  const steps = [];
  proof.prove(box.ctx(), tag, text => steps.push(text));
  return steps;
};

test('a released tag is proven in four steps and each step runs the commands of the configuration', (t) => {
  const box = locked(t);
  assert.deepEqual(prove(box), [
    'the release v0.0.1 lists exactly its 3 archives',
    'downloaded [fixture-app-npm-0.0.1.tgz, fixture-lib-npm-0.0.1.tgz, polyspec-kit-fixture-php-0.0.1.zip] from the release v0.0.1',
    'npm ci of 2 packages from tests/release-consumer/npm',
    "npm fixture-lib 0.0.1: node -e require('fixture-lib/package.json')",
    "npm fixture-app 0.0.1: node -e require('fixture-app/package.json')",
    'composer install of 1 packages from tests/release-consumer/composer',
    "composer polyspec/kit-fixture 0.0.1: node -e require('./vendor/composer/installed.json')",
    'installed and checked 3 packages from the release assets',
    'packages/fixture-python/pyproject.toml: pip installed kit-fixture from v0.0.1 and python -c import kit_fixture passed',
    'packages/fixture-rust/Cargo.toml: cargo resolved kit-fixture-rust from v0.0.1 and cargo check passed',
    'the Go module example.com/kit-fixture-go resolves at packages/fixture-go/v0.0.1',
  ]);
  const [view] = box.calls('gh');
  assert.deepEqual(view.args, ['release', 'view', 'v0.0.1', '--repo', REMOTE, '--json', 'assets']);
  assert.deepEqual(box.calls('gh')[1].args.slice(0, 4), ['release', 'download', 'v0.0.1', '--repo']);
  const venv = box.calls('python3')[0];
  assert.deepEqual(venv.args.slice(0, 2), ['-m', 'venv']);
  const python = box.calls('python');
  assert.deepEqual(python[0].args, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', `kit-fixture @ git+${URL}@v0.0.1#subdirectory=packages/fixture-python`]);
  assert.deepEqual(python[1].args, ['-c', 'import kit_fixture']);
  assert.equal(python[1].env.VIRTUAL_ENV, venv.args[2], 'the smoke command runs in the virtual environment');
  const [cargo] = box.calls('cargo');
  assert.deepEqual(cargo.args, ['check']);
  assert.match(cargo.manifest, new RegExp(`\\[dependencies\\]\\nkit-fixture-rust = \\{ git = "${URL}", tag = "v0\\.0\\.1" \\}\\n$`));
  assert.ok(path.relative(box.root, cargo.cwd).startsWith('..'), 'the temporary crate is outside the repository');
  const [go] = box.calls('go');
  assert.deepEqual(go.args, ['list', '-m', 'example.com/kit-fixture-go@v0.0.1']);
  assert.deepEqual([go.env.GOFLAGS, go.env.GOPROXY], ['-mod=mod', 'direct']);
});

test('the proof stops when the release lists other archives than the configuration declares', (t) => {
  const box = locked(t);
  box.stub({ release: { names: box.names.slice(1).concat('extra.txt'), source: path.join(box.root, release.ASSETS) } });
  stop(() => prove(box), /the release v0\.0\.1 lists \[extra\.txt, fixture-app-npm-0\.0\.1\.tgz, polyspec-kit-fixture-php-0\.0\.1\.zip\], expected \[fixture-app-npm-0\.0\.1\.tgz, fixture-lib-npm-0\.0\.1\.tgz, polyspec-kit-fixture-php-0\.0\.1\.zip\]; missing \[fixture-lib-npm-0\.0\.1\.tgz\]; unexpected \[extra\.txt\]/);
  assert.equal(installs(box).length, 0, 'no install runs after a failed step');
  box.stub({ release: { names: [], source: path.join(box.root, release.ASSETS) } });
  stop(() => prove(box), /the release v0\.0\.1 lists \[\], expected \[fixture-app-npm-0\.0\.1\.tgz/);
});

test('the proof fails when gh cannot view or download the release', (t) => {
  const box = locked(t);
  box.stub({ modes: { gh: 'fail' } });
  stop(() => prove(box), /gh release view v0\.0\.1 --repo example\.com\/polyspec\/kit-fixture --json assets exited with 1: gh stub: release view failed/);
});

test('the proof fails when the downloaded archives do not install', (t) => {
  const box = locked(t);
  box.stub({ modes: { npm: 'fail' } });
  stop(() => prove(box), /npm ci .* exited with 1: npm stub: ci failed/);
  box.stub({ modes: { npm: '', composer: 'wrong-version' } });
  stop(() => prove(box), /composer installed polyspec\/kit-fixture 9\.9\.9, expected 0\.0\.1/);
});

test('the proof fails when the consumer projects of the checkout name other archives', (t) => {
  const box = locked(t);
  const lock = readJson(box.root, 'tests/release-consumer/composer/composer.json');
  writeJson(box.root, 'tests/release-consumer/composer/composer.json', { ...lock, require: { 'polyspec/kit-fixture': '0.0.0' } });
  stop(() => prove(box), /require\.polyspec\/kit-fixture is "0\.0\.0", expected "0\.0\.1"/);
});

test('the proof fails when a smoke command of an archive fails', (t) => {
  const box = locked(t);
  const config = readJson(box.root, 'config/release.json');
  config.consumers.npm.smoke['fixture-lib'] = ['node', '-e', 'process.exit(3)'];
  writeJson(box.root, 'config/release.json', config);
  stop(() => prove(box), /node -e process\.exit\(3\) exited with 3/);
});

test('the proof fails when pip cannot install the tag, when the venv cannot be made and when the smoke command fails', (t) => {
  const box = locked(t);
  box.stub({ modes: { python: 'pip-fail' } });
  stop(() => prove(box), /python -m pip install .*kit-fixture @ git\+https:\/\/example\.com\/polyspec\/kit-fixture@v0\.0\.1#subdirectory=packages\/fixture-python exited with 1: pip stub: no matching distribution/);
  box.stub({ modes: { python: 'smoke-fail' } });
  stop(() => prove(box), /python -c import kit_fixture exited with 1: python stub: ModuleNotFoundError/);
  box.stub({ modes: { python3: 'venv-fail', python: '' } });
  stop(() => prove(box), /python3 -m venv .* exited with 1: python3 stub: venv failed/);
});

test('a git-tag manifest at the repository root installs without a subdirectory', (t) => {
  const box = locked(t);
  const config = readJson(box.root, 'config/release.json');
  const { ['packages/fixture-python/pyproject.toml']: entry, ...rest } = config.proof.gitTag;
  const { ['packages/fixture-python/pyproject.toml']: mode, ...manifests } = config.manifests;
  writeJson(box.root, 'config/release.json', { ...config, manifests: { ...manifests, 'pyproject.toml': mode }, proof: { gitTag: { ...rest, 'pyproject.toml': entry } }, notReleased: config.notReleased });
  prove(box);
  assert.equal(box.calls('python')[0].args.at(-1), `kit-fixture @ git+${URL}@v0.0.1`);
});

test('the proof fails when cargo cannot resolve the tag', (t) => {
  const box = locked(t);
  box.stub({ modes: { cargo: 'fail' } });
  stop(() => prove(box), /cargo check exited with 101: cargo stub: failed to find tag/);
});

test('the proof fails without a proof entry for a git-tag manifest', (t) => {
  const box = locked(t);
  const { proof: _, ...config } = readJson(box.root, 'config/release.json');
  writeJson(box.root, 'config/release.json', config);
  assert.equal(release.loadConfig(box.root).proof, undefined, 'the section is optional for the other release steps');
  stop(() => prove(box), /config\/release\.json proof\.gitTag lacks packages\/fixture-python\/pyproject\.toml, which manifests releases by "git-tag"/);
});

test('the proof fails when the tag of a Go module is not on the remote', (t) => {
  const box = locked(t);
  git(box.root, 'tag', '-d', 'packages/fixture-go/v0.0.1');
  stop(() => prove(box), /the tag packages\/fixture-go\/v0\.0\.1 of the Go module example\.com\/kit-fixture-go is not on https:\/\/example\.com\/polyspec\/kit-fixture, git ls-remote lists \[\]/);
  assert.equal(box.calls('go').length, 0);
});

test('the proof fails when the Go tool does not resolve the module or resolves another version', (t) => {
  const box = locked(t);
  box.stub({ modes: { go: 'fail' } });
  stop(() => prove(box), /go list -m example\.com\/kit-fixture-go@v0\.0\.1 exited with 1: go stub: example\.com\/kit-fixture-go@v0\.0\.1: reading failed/);
  box.stub({ modes: { go: 'other' } });
  stop(() => prove(box), /go list -m example\.com\/kit-fixture-go@v0\.0\.1 printed "example\.com\/kit-fixture-go v9\.9\.9", expected "example\.com\/kit-fixture-go v0\.0\.1"/);
});

test('a Go module at the repository root is resolved at the tag of the release', (t) => {
  const box = locked(t);
  const config = readJson(box.root, 'config/release.json');
  writeJson(box.root, 'config/release.json', { ...config, goModules: { '.': 'example.com/kit-fixture-root' } });
  const steps = prove(box);
  assert.equal(steps.at(-1), 'the Go module example.com/kit-fixture-root resolves at v0.0.1');
});

test('the tag of a Go module is proven by the module alone and its release lists no archive', (t) => {
  const box = locked(t);
  box.stub({ release: { names: [], source: path.join(box.root, release.ASSETS) } });
  const steps = prove(box, 'packages/fixture-go/v0.0.1');
  assert.deepEqual(steps, [
    'the release packages/fixture-go/v0.0.1 lists no archive',
    'packages/fixture-go/v0.0.1 is a Go module tag: the release holds no archive and no git-tag manifest',
    'the Go module example.com/kit-fixture-go resolves at packages/fixture-go/v0.0.1',
  ]);
  assert.deepEqual([installs(box).length, box.calls('python3').length, box.calls('cargo').length], [0, 0, 0]);
});

test('the proof removes its temporary directory and changes nothing in the checkout', (t) => {
  const box = locked(t);
  const before = git(box.root, 'status', '--porcelain', '--ignored');
  prove(box);
  assert.equal(git(box.root, 'status', '--porcelain', '--ignored'), before);
  const folder = path.dirname(path.dirname(box.calls('python3')[0].args[2]));
  assert.match(path.basename(folder), /^kit-release-proof-/);
  assert.equal(existsSync(folder), false);
});

test('the command line prints one line for each step and the exit status', (t) => {
  const box = locked(t);
  const lines = [];
  const errors = [];
  const run = argv => proof.main(argv, { root: box.root, env: box.env, print: line => lines.push(line), error: line => errors.push(line) });
  assert.equal(run(['v0.0.1']), 0);
  assert.ok(lines.every(line => line.startsWith('✔ ')), lines.join('\n'));
  assert.equal(lines.length, 12);
  assert.equal(lines.at(-1), '✔ v0.0.1 is proven from outside the repository');
  box.stub({ modes: { go: 'fail' } });
  assert.equal(run(['v0.0.1']), 1);
  assert.match(errors.at(-1), /^\[release-proof\] v0\.0\.1 failed: go list -m example\.com\/kit-fixture-go@v0\.0\.1 exited with 1/);
  assert.equal(run(['v0.0']), 1);
  assert.match(errors.at(-1), /v0\.0 failed: v0\.0: a release tag is vX\.Y\.Z/);
  for (const argv of [[], ['v0.0.1', 'x']]) assert.equal(run(argv), 2);
  assert.equal(errors.at(-1), 'usage: node scripts/kit/release-proof.mjs TAG');
});

test('make release-proof takes the tag of the environment', (t) => {
  const box = locked(t);
  const make = (...args) => spawnSync('make', ['-f', 'scripts/kit/kit.mk', ...args], { cwd: box.root, env: box.env, encoding: 'utf8' });
  const without = make('release-proof');
  assert.equal(without.status, 2);
  assert.match(without.stdout + without.stderr, /release-proof: TAG is required, for example make release-proof TAG=v0\.0\.1/);
  const result = make('release-proof', 'TAG=v0.0.1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /✔ v0\.0\.1 is proven from outside the repository/);
});
