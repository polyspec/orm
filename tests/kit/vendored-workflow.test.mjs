// The release workflow that kit vendors into a consumer (kit.json `vendoredFiles`): kit-sync copies the source file of kit to
// the workflow path of the checkout and records it in the lock, and kit-check fails when the checkout's file differs. A
// repository never edits its copy. No test uses the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { check, LOCK } from '../../scripts/kit/kit-check.mjs';
import { sync } from '../../scripts/kit/kit-sync.mjs';
import { initRepository } from './sandbox-repository.mjs';

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
const WORKFLOW = 'on: push\njobs:\n  release:\n    steps:\n      - run: make release-publish\n';

// A kit repository whose tag v0.0.1 holds a vendored script and the release workflow source.
function kitRepository(t) {
  const repository = mkdtempSync(path.join(tmpdir(), 'kit-source-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  initRepository(repository, '-b', 'main');
  write(repository, 'kit.json', JSON.stringify({ schema: 1, vendored: ['scripts/kit'], vendoredFiles: { '.github/workflows/release.yml': 'workflows/release.yml' } }) + '\n');
  write(repository, 'scripts/kit/tool.mjs', 'export const v = 1;\n');
  write(repository, 'workflows/release.yml', WORKFLOW);
  git(['add', '-A'], repository);
  git(['commit', '--quiet', '-m', 'v0.0.1'], repository);
  git(['tag', 'v0.0.1'], repository);
  return repository;
}

const consumer = t => {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('kit-sync copies the release workflow of kit to .github/workflows/release.yml and the lock records it', (t) => {
  const repository = kitRepository(t);
  const root = consumer(t);
  const changes = sync({ root, repository, tag: 'v0.0.1' });
  assert.ok(changes.includes('added .github/workflows/release.yml'), changes.join('\n'));
  assert.equal(readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8'), WORKFLOW);
  const lock = JSON.parse(readFileSync(path.join(root, LOCK), 'utf8'));
  assert.ok('.github/workflows/release.yml' in lock.files, 'the lock names the workflow path of the checkout');
  assert.deepEqual(check(root), []);
});

test('kit-check fails when a consumer workflow differs from the vendored release workflow, and names the fix', (t) => {
  const repository = kitRepository(t);
  const root = consumer(t);
  sync({ root, repository, tag: 'v0.0.1' });
  write(root, '.github/workflows/release.yml', WORKFLOW.replace('make release-publish', 'make release-publish\n      - run: make release-proof'));
  const findings = check(root);
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /^\.github\/workflows\/release\.yml: sha256 is [0-9a-f]{64}, the lock records [0-9a-f]{64}\. Fix: make kit-sync KIT_TAG=v0\.0\.1$/);
});

test('kit-check fails when the vendored release workflow is missing', (t) => {
  const repository = kitRepository(t);
  const root = consumer(t);
  sync({ root, repository, tag: 'v0.0.1' });
  rmSync(path.join(root, '.github/workflows/release.yml'));
  const findings = check(root);
  assert.equal(findings.length, 1, findings.join('\n'));
  assert.match(findings[0], /^\.github\/workflows\/release\.yml: the vendored file is missing; expected sha256 [0-9a-f]{64}\. Fix: make kit-sync KIT_TAG=v0\.0\.1$/);
});
