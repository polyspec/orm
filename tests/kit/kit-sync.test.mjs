// Tests of kit-sync and kit-check (scripts/kit): a kit repository of a temporary directory is cloned at a tag, its
// vendored files are copied into a consumer checkout, and the lock and the check agree. No test uses the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { check, LOCK } from '../../scripts/kit/kit-check.mjs';
import { DEFAULT_REPOSITORY, parseSyncArguments, sync } from '../../scripts/kit/kit-sync.mjs';

const KIT_SYNC = path.join(import.meta.dirname, '../../scripts/kit/kit-sync.mjs');

// Runs the command of kit-sync with `args`. `git` is a stub on PATH that logs its arguments to STUB_LOG and fails, so no clone
// reaches the network and `clones` holds the argument lists of the git calls that the command made.
function syncCommand(t, args) {
  const bin = mkdtempSync(path.join(tmpdir(), 'kit-sync-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'git.log');
  writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env node\nrequire(\'node:fs\').appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + \'\\n\');\nprocess.exit(1);\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [KIT_SYNC, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_LOG: log },
  });
  const clones = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { status: result.status, stderr: result.stderr, clones };
}

const GIT = ['-c', 'user.name=kit-test', '-c', 'user.email=kit-test@example.com'];
const git = (args, cwd) => {
  const result = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const write = (root, file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

// A kit repository whose tags v0.0.1, v0.0.2 and v0.0.3 hold the given files.
function kitRepository(t, releases) {
  const repository = mkdtempSync(path.join(tmpdir(), 'kit-source-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(['init', '--quiet', '-b', 'main'], repository);
  for (const [tag, files] of Object.entries(releases)) {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) rmSync(path.join(repository, file));
      else write(repository, file, text);
    }
    git(['add', '-A'], repository);
    git(['commit', '--quiet', '--allow-empty', '-m', tag], repository);
    git(['tag', tag], repository);
  }
  return repository;
}

const consumer = t => {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const manifest = { 'kit.json': JSON.stringify({ schema: 1, vendored: ['scripts/kit', 'tests/kit'] }) + '\n' };

test('the first sync copies the vendored files and the lock agrees with them', (t) => {
  const repository = kitRepository(t, { 'v0.0.1': { ...manifest, 'scripts/kit/tool.mjs': 'export const v = 1;\n', 'tests/kit/tool.test.mjs': 'test\n' } });
  const root = consumer(t);
  const changes = sync({ root, repository, tag: 'v0.0.1' });
  assert.deepEqual(changes.filter(line => line.startsWith('added')).sort(), ['added kit.json', 'added scripts/kit/tool.mjs', 'added tests/kit/tool.test.mjs']);
  assert.ok(changes.includes(`written ${LOCK}`));
  assert.deepEqual(check(root), []);
  const lock = JSON.parse(readFileSync(path.join(root, LOCK), 'utf8'));
  assert.equal(lock.tag, 'v0.0.1');
  assert.deepEqual(Object.keys(lock.files).sort(), ['kit.json', 'scripts/kit/tool.mjs', 'tests/kit/tool.test.mjs']);
});

test('a second sync at the same tag changes nothing and writes the same lock', (t) => {
  const repository = kitRepository(t, { 'v0.0.1': { ...manifest, 'scripts/kit/tool.mjs': 'export const v = 1;\n' } });
  const root = consumer(t);
  sync({ root, repository, tag: 'v0.0.1' });
  const lock = readFileSync(path.join(root, LOCK), 'utf8');
  assert.deepEqual(sync({ root, repository, tag: 'v0.0.1' }), []);
  assert.equal(readFileSync(path.join(root, LOCK), 'utf8'), lock);
});

test('a sync to a new tag writes the changed file, and a file that kit removed is removed', (t) => {
  const repository = kitRepository(t, {
    'v0.0.1': { ...manifest, 'scripts/kit/tool.mjs': 'v1\n', 'scripts/kit/old.mjs': 'old\n' },
    'v0.0.2': { 'scripts/kit/tool.mjs': 'v2\n', 'scripts/kit/old.mjs': null },
  });
  const root = consumer(t);
  sync({ root, repository, tag: 'v0.0.1' });
  const changes = sync({ root, repository, tag: 'v0.0.2' });
  assert.ok(changes.includes('written scripts/kit/tool.mjs'), changes.join('\n'));
  assert.ok(changes.includes('removed scripts/kit/old.mjs'), changes.join('\n'));
  assert.equal(existsSync(path.join(root, 'scripts/kit/old.mjs')), false);
  assert.deepEqual(check(root), []);
});

test('kit-check names a changed vendored file, a missing one and an unexpected one, with expected and actual values', (t) => {
  const repository = kitRepository(t, { 'v0.0.1': { ...manifest, 'scripts/kit/tool.mjs': 'v1\n', 'scripts/kit/other.mjs': 'o\n' } });
  const root = consumer(t);
  sync({ root, repository, tag: 'v0.0.1' });
  write(root, 'scripts/kit/tool.mjs', 'edited\n');
  rmSync(path.join(root, 'scripts/kit/other.mjs'));
  write(root, 'scripts/kit/extra.mjs', 'unexpected\n');
  const findings = check(root);
  assert.equal(findings.length, 3, findings.join('\n'));
  assert.match(findings[0], /^scripts\/kit\/other\.mjs: the vendored file is missing; expected sha256 [0-9a-f]{64}\. Fix: make kit-sync KIT_TAG=v0\.0\.1$/);
  assert.match(findings[1], /^scripts\/kit\/tool\.mjs: sha256 is [0-9a-f]{64}, the lock records [0-9a-f]{64}\. Fix: make kit-sync KIT_TAG=v0\.0\.1$/);
  assert.match(findings[2], /^scripts\/kit\/extra\.mjs: the file is not in the lock\. Fix: make kit-sync KIT_TAG=v0\.0\.1$/);
  sync({ root, repository, tag: 'v0.0.1' });
  assert.deepEqual(check(root), []);
});

test('kit-check fails when the lock is missing and names the fix', (t) => {
  assert.deepEqual(check(consumer(t)), [`${LOCK}: the lock is missing. Fix: make kit-sync KIT_TAG=<tag>`]);
});

test('without --repository, the tag is cloned from DEFAULT_REPOSITORY', (t) => {
  const { status, clones } = syncCommand(t, ['--tag', 'v0.0.1']);
  assert.equal(clones.length, 1, JSON.stringify(clones));
  assert.equal(clones[0].at(-2), DEFAULT_REPOSITORY);
  assert.equal(status, 1);
});

test('with --repository, the tag is cloned from the given repository', (t) => {
  const { clones } = syncCommand(t, ['--tag', 'v0.0.1', '--repository', '/kits/local']);
  assert.equal(clones.length, 1, JSON.stringify(clones));
  assert.equal(clones[0].at(-2), '/kits/local');
});

test('an option without a value, or followed by another option, fails with the usage and status 2 before any clone', (t) => {
  const usage = /usage: node scripts\/kit\/kit-sync\.mjs --tag <tag> \[--repository <url or path>\]/;
  for (const [args, option] of [
    [['--tag', 'v0.0.1', '--repository'], '--repository'],
    [['--repository', '--tag', 'v0.0.1'], '--repository'],
    [['--tag', '--repository', 'https://example.com/kit'], '--tag'],
    [['--tag'], '--tag'],
  ]) {
    const { status, stderr, clones } = syncCommand(t, args);
    assert.equal(status, 2, `${args.join(' ')}: ${stderr}`);
    assert.ok(stderr.includes(option), `${args.join(' ')} names ${option}: ${stderr}`);
    assert.match(stderr, usage, args.join(' '));
    assert.deepEqual(clones, [], args.join(' '));
  }
});

test('a missing --tag fails with status 2 before any clone', (t) => {
  const { status, stderr, clones } = syncCommand(t, ['--repository', 'https://example.com/kit']);
  assert.equal(status, 2);
  assert.match(stderr, /--tag is required/);
  assert.deepEqual(clones, []);
});

test('parseSyncArguments reads the tag, and the repository is DEFAULT_REPOSITORY unless --repository is given', () => {
  assert.deepEqual(parseSyncArguments(['--tag', 'v0.0.1']), { tag: 'v0.0.1', repository: DEFAULT_REPOSITORY });
  assert.deepEqual(parseSyncArguments(['--tag=v0.0.1', '--repository', '/kits/local']), { tag: 'v0.0.1', repository: '/kits/local' });
});

test('parseSyncArguments names the option that has no value, and the tag that is missing', () => {
  assert.throws(() => parseSyncArguments(['--tag', 'v0.0.1', '--repository']), /--repository/);
  assert.throws(() => parseSyncArguments(['--tag', 'v0.0.1', '--repository', '--tag']), /--repository/);
  assert.throws(() => parseSyncArguments(['--tag', '', '--repository', 'x']), /--tag is required/);
  assert.throws(() => parseSyncArguments(['--tag', 'v0.0.1', '--repository=']), /--repository has no value/);
  assert.throws(() => parseSyncArguments(['--tag', 'v0.0.1', '--bogus']), /Unknown option '--bogus'/);
});

test('the command syncs a tag from the repository of --repository and prints the changes', (t) => {
  const repository = kitRepository(t, { 'v0.0.1': { 'kit.json': JSON.stringify({ schema: 1, vendored: [] }) + '\n' } });
  const root = consumer(t);
  cpSync(path.join(import.meta.dirname, '../../scripts/kit'), path.join(root, 'scripts/kit'), { recursive: true });
  // The script is named by its real path: Node runs a module by the path that its import.meta.url gives, after symlinks.
  const script = path.join(realpathSync(root), 'scripts/kit/kit-sync.mjs');
  const result = spawnSync(process.execPath, [script, '--tag', 'v0.0.1', '--repository', repository], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `[kit-sync] added kit.json\n[kit-sync] written ${LOCK}\n[kit-sync] 2 changes from v0.0.1\n`);
  assert.deepEqual(check(root), []);
});

test('parseSyncArguments rejects a repeated option and names it, instead of taking one of the values', () => {
  assert.throws(() => parseSyncArguments(['--tag', 'v0.0.1', '--tag', 'v0.0.2']), /--tag is given more than once\. usage:/);
  assert.throws(() => parseSyncArguments(['--tag', 'v0.0.1', '--repository', 'a', '--repository', 'b']), /--repository is given more than once\. usage:/);
  assert.throws(() => parseSyncArguments(['--tag=v0.0.1', '--tag=v0.0.1']), /--tag is given more than once/);
});

test('a repeated option fails with the usage and status 2 before any clone', (t) => {
  for (const [args, option] of [
    [['--tag', 'v0.0.1', '--tag', 'v0.0.2'], '--tag'],
    [['--tag', 'v0.0.1', '--repository', 'a', '--repository', 'b'], '--repository'],
  ]) {
    const { status, stderr, clones } = syncCommand(t, args);
    assert.equal(status, 2, `${args.join(' ')}: ${stderr}`);
    assert.ok(stderr.includes(`${option} is given more than once`), stderr);
    assert.match(stderr, /usage: node scripts\/kit\/kit-sync\.mjs/);
    assert.deepEqual(clones, [], args.join(' '));
  }
});
