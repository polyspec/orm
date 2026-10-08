// Tests of the make targets of the gates in scripts/kit/kit.mk: the commands that each target runs, and the setting of
// core.hooksPath at every make invocation of a checkout that tracks the pre-push hook.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { git, run } from './gates-checkout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function repository(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kit-gate-targets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, 'scripts/kit'), { recursive: true });
  cpSync(path.join(ROOT, 'scripts/kit/kit.mk'), path.join(directory, 'scripts/kit/kit.mk'));
  writeFileSync(path.join(directory, 'Makefile'), 'include scripts/kit/kit.mk\n');
  git(directory, 'init', '--quiet');
  return directory;
}

const commands = (directory, ...args) => {
  const made = run(directory, 'make', ['--no-print-directory', '-n', ...args]);
  assert.equal(made.status, 0, made.stderr);
  return made.stdout.split('\n').filter(Boolean);
};

test('each target runs the tool of its gate with the commit and the keys that the variables name', (t) => {
  const directory = repository(t);
  assert.deepEqual(commands(directory, 'hooks'), ['node scripts/kit/git-hooks.mjs install']);
  assert.deepEqual(commands(directory, 'hooks-check'), ['node scripts/kit/git-hooks.mjs check']);
  assert.deepEqual(commands(directory, 'push-gate-commit'), ['node scripts/kit/push-gate.mjs commit HEAD']);
  assert.deepEqual(commands(directory, 'push-gate-commit', 'COMMIT=abc123'), ['node scripts/kit/push-gate.mjs commit abc123']);
  assert.deepEqual(commands(directory, 'rerun-failed'), ['node scripts/kit/full-run.mjs rerun-failed']);
  assert.deepEqual(commands(directory, 'rerun-failed', 'FULL_RUN_KEYS=--key dep=c1'), ['node scripts/kit/full-run.mjs rerun-failed --key dep=c1']);
});

test('a make invocation sets core.hooksPath in a checkout that tracks the pre-push hook, and in no other', (t) => {
  const directory = repository(t);
  commands(directory, 'hooks-check');
  assert.equal(run(directory, 'git', ['config', 'core.hooksPath']).status, 1, 'a checkout without the hook got a hooks path');
  mkdirSync(path.join(directory, '.githooks'));
  writeFileSync(path.join(directory, '.githooks/pre-push'), '#!/bin/sh\n');
  commands(directory, 'hooks-check');
  assert.equal(git(directory, 'config', 'core.hooksPath'), '.githooks');
  git(directory, 'config', 'core.hooksPath', 'elsewhere');
  commands(directory, 'hooks-check');
  assert.equal(git(directory, 'config', 'core.hooksPath'), '.githooks');
});

test('the dependency targets run the gate, its mutation check and the review with the flags that the variables name', (t) => {
  const directory = repository(t);
  // make leaves the spaces of an empty $(if) in a printed recipe line, so the lines are compared with single spaces and no edge spaces.
  const lines = (...args) => commands(directory, ...args).map(line => line.trim().replace(/\s+/g, ' '));
  assert.deepEqual(lines('dependency-policy-check'), ['node scripts/kit/check-dependency-policy.mjs']);
  assert.deepEqual(lines('dependency-policy-mutation-check'), ['node scripts/kit/check-dependency-policy-mutation.mjs']);
  assert.deepEqual(lines('dependency-review'), ['node scripts/kit/dependency-review.mjs']);
  assert.deepEqual(lines('dependency-review', 'RECORD=1'), ['node scripts/kit/dependency-review.mjs --record']);
  assert.deepEqual(lines('dependency-review', 'UPDATE=1', 'RECORD=1'), ['node scripts/kit/dependency-review.mjs --record --update']);
});
