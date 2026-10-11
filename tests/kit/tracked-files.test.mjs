// Tests of the file list (scripts/kit/tracked-files.mjs): each path is listed once, in sorted order, also while a merge or a
// cherry-pick is unresolved, when Git lists the unmerged path once for each of its stages.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { trackedFiles } from '../../scripts/kit/tracked-files.mjs';

const IDENTITY = ['-c', 'user.name=kit-test', '-c', 'user.email=kit-test@example.invalid', '-c', 'commit.gpgsign=false'];

/** Runs `git <args>` in `root` and returns the result; a conflict is an answer, so the status is not checked here. */
function git(root, ...args) {
  return spawnSync('git', [...IDENTITY, ...args], { cwd: root, encoding: 'utf8' });
}

/** Writes `files` ({ path: text }) below `root`. */
function write(root, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

/** A repository where `a.md` is edited on the branch `side` and on the initial branch, so the next `command` conflicts. */
function conflicted(t, command) {
  const root = mkdtempSync(path.join(tmpdir(), 'kit-tracked-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '--quiet');
  write(root, { 'a.md': 'one\n', 'b.md': 'keep\n', 'c.md': 'z\n' });
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'base');
  git(root, 'checkout', '--quiet', '-b', 'side');
  write(root, { 'a.md': 'two\n' });
  git(root, 'commit', '--quiet', '-am', 'side edit');
  git(root, 'checkout', '--quiet', '-');
  write(root, { 'a.md': 'three\n' });
  git(root, 'commit', '--quiet', '-am', 'base edit');
  const result = command === 'merge' ? git(root, 'merge', '--no-edit', 'side') : git(root, 'cherry-pick', 'side');
  assert.notEqual(result.status, 0, `${command} must stop on the conflict`);
  assert.match(git(root, 'status', '--porcelain').stdout, /^UU a\.md$/m);
  return root;
}

test('an unresolved merge lists the conflicted path once, in sorted order', (t) => {
  const root = conflicted(t, 'merge');
  assert.deepEqual(trackedFiles(root), ['a.md', 'b.md', 'c.md']);
});

test('an unresolved cherry-pick lists the conflicted path once, in sorted order', (t) => {
  const root = conflicted(t, 'cherry-pick');
  assert.deepEqual(trackedFiles(root), ['a.md', 'b.md', 'c.md']);
});

test('the new files that Git does not ignore join the tracked files in sorted order, and ignored files stay out', (t) => {
  const root = conflicted(t, 'merge');
  write(root, { 'b-new.md': 'new\n', 'var/out.md': 'run\n', '.gitignore': 'var/\n' });
  assert.deepEqual(trackedFiles(root), ['.gitignore', 'a.md', 'b-new.md', 'b.md', 'c.md']);
});
