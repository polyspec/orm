// Tests of kit-sync and kit-check (scripts/kit): a kit repository of a temporary directory is cloned at a tag, its
// vendored files are copied into a consumer checkout, and the lock and the check agree. No test uses the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { check, LOCK } from '../../scripts/kit/kit-check.mjs';
import { sync } from '../../scripts/kit/kit-sync.mjs';

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
