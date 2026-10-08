// Tests of the Git hooks (scripts/kit/git-hooks.mjs): `install` sets core.hooksPath, writes the pre-push hook and makes the
// listed hooks executable, a second run changes nothing, and `check` fails with the cause and the fix for each hook that is
// not installed.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HOOKS_PATH, PRE_PUSH, PRE_PUSH_CONTENT, hooksIssue, installHooks } from '../../scripts/kit/git-hooks.mjs';
import { checkout, git, run } from './gates-checkout.mjs';

const hooks = work => run(work, process.execPath, ['scripts/kit/git-hooks.mjs', 'install']);
const check = work => run(work, process.execPath, ['scripts/kit/git-hooks.mjs', 'check']);

test('install sets core.hooksPath and writes the executable pre-push hook; check passes', (t) => {
  const { work } = checkout(t);
  assert.equal(check(work).status, 1);
  const installed = hooks(work);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /\[git-hooks\] core\.hooksPath set to \.githooks \(was not set\)\n\[git-hooks\] \.githooks\/pre-push written\n\[git-hooks\] the hooks pre-push are installed: core\.hooksPath is \.githooks/);
  assert.equal(git(work, 'config', 'core.hooksPath'), HOOKS_PATH);
  assert.equal(readFileSync(path.join(work, PRE_PUSH), 'utf8'), PRE_PUSH_CONTENT);
  assert.equal(statSync(path.join(work, PRE_PUSH)).mode & 0o777, 0o755);
  assert.equal(check(work).status, 0);
});

test('a second install changes nothing: no file is rewritten and no setting is touched', (t) => {
  const { work } = checkout(t);
  assert.equal(hooks(work).status, 0);
  const before = statSync(path.join(work, PRE_PUSH));
  const second = hooks(work);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^\[git-hooks\] nothing to change\n\[git-hooks\] the hooks pre-push are installed/);
  const after = statSync(path.join(work, PRE_PUSH));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(installHooks(work), []);
});

test('check fails while core.hooksPath is not .githooks, naming the value and make hooks', (t) => {
  const { work } = checkout(t);
  hooks(work);
  git(work, 'config', 'core.hooksPath', 'elsewhere');
  const failed = check(work);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /core\.hooksPath is "elsewhere", not \.githooks, so Git does not run the hooks; run make hooks/);
  git(work, 'config', '--unset', 'core.hooksPath');
  assert.match(check(work).stderr, /core\.hooksPath is not set, not \.githooks/);
});

test('check fails while the pre-push hook is missing, not executable or changed; install repairs them', (t) => {
  const { work } = checkout(t);
  hooks(work);
  const file = path.join(work, PRE_PUSH);
  rmSync(file);
  assert.match(check(work).stderr, /\.githooks\/pre-push does not exist; restore it from Git and run make hooks/);

  assert.equal(hooks(work).status, 0);
  chmodSync(file, 0o644);
  assert.match(check(work).stderr, /\.githooks\/pre-push is not executable, so Git does not run it; run make hooks/);
  assert.equal(hooks(work).status, 0);
  assert.equal(statSync(file).mode & 0o777, 0o755);

  writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.match(check(work).stderr, /\.githooks\/pre-push differs from the hook of scripts\/kit\/git-hooks\.mjs; run make hooks and commit the file/);
  assert.match(hooks(work).stdout, /\.githooks\/pre-push written/);
  assert.equal(check(work).status, 0);
});

test('the listed hooks of the repository are checked and made executable, and a missing one fails the check', (t) => {
  const config = { schema: 1, hooks: ['pre-push', 'commit-msg'], trackers: [{ path: 'docs/plans/execution-checklist.md', format: 'table', active: '[~]' }] };
  const { work } = checkout(t, { config });
  const failed = hooks(work);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /\.githooks\/commit-msg does not exist; restore it from Git and run make hooks/);
  const hook = path.join(work, '.githooks/commit-msg');
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  assert.match(check(work).stderr, /\.githooks\/commit-msg is not executable/);
  const installed = hooks(work);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /\.githooks\/commit-msg made executable/);
  assert.equal(statSync(hook).mode & 0o100, 0o100);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n', 'install does not rewrite a hook of the repository');
  assert.equal(existsSync(path.join(work, '.githooks/pre-push')), true);
  assert.equal(hooksIssue(work), null);
});

test('git-hooks takes only install or check', (t) => {
  const { work } = checkout(t);
  const refused = run(work, process.execPath, ['scripts/kit/git-hooks.mjs', 'remove']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Usage: node scripts\/kit\/git-hooks\.mjs install \| check/);
});
