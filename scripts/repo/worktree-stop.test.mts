import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { caseTest, COMPUTE, PROCESS } from '../../tests/testcase.mts';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { stopTargetOf } from '@polyspec/kit/land';

const root = resolve(import.meta.dirname, '../..');

function withIsolatedEnvironment<T>(body: () => T): T {
  const env = isolatedEnvironment();
  const saved = Object.fromEntries(Object.entries(process.env));
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return body();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

function worktreeRemoveRecipe(): string[] {
  const lines = readFileSync(join(root, 'Makefile'), 'utf8').split('\n');
  const target = lines.indexOf('worktree-remove:');
  assert.notEqual(target, -1);
  const recipe: string[] = [];
  for (const line of lines.slice(target + 1)) {
    if (!line.startsWith('\t')) break;
    recipe.push(line);
  }
  assert.ok(recipe.length > 0);
  return recipe;
}

function runWorktreeRemove(hasServerState: boolean, stopStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'orm-worktree-remove-'));
  try {
    const worktree = join(directory, 'source-only');
    const bin = join(directory, 'bin');
    const events = join(directory, 'events');
    const makefile = join(directory, 'Makefile');
    const stopMake = join(bin, 'make');
    const git = join(bin, 'git');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin);
    if (hasServerState) mkdirSync(join(worktree, '.runtime', 'servers'), { recursive: true });
    writeFileSync(stopMake, '#!/bin/sh\nprintf \'stop %s\\n\' "$*" >> "$EVENTS"\nexit "$STOP_STATUS"\n');
    writeFileSync(git, '#!/bin/sh\nprintf \'git %s\\n\' "$*" >> "$EVENTS"\n');
    chmodSync(stopMake, 0o755);
    chmodSync(git, 0o755);
    writeFileSync(makefile, `WORKTREE = ${worktree}\n.PHONY: worktree-remove\nworktree-remove:\n${worktreeRemoveRecipe().join('\n')}\n`);
    const env = isolatedEnvironment({ EVENTS: events, STOP_STATUS: String(stopStatus) });
    env.PATH = `${bin}${delimiter}${env.PATH ?? ''}`;
    const result = spawnSync('/usr/bin/make', [
      '--no-print-directory', '-f', makefile, 'worktree-remove',
      `WORKTREE=${worktree}`, `MAKE=${stopMake}`,
    ], { cwd: directory, encoding: 'utf8', env });
    return { result, events: existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [], worktree };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

caseTest('the kit make database reads the ORM Makefile-origin stop target', COMPUTE, () => {
  assert.deepEqual(withIsolatedEnvironment(() => stopTargetOf(root)), ['orm-test-servers-stop']);
  assert.match(readFileSync(join(root, 'Makefile'), 'utf8'), /^WORKTREE_STOP = orm-test-servers-stop$/m);
});

caseTest('worktree-remove skips the server make target when a source-only worktree has no server state', PROCESS, () => {
  const { result, events, worktree } = runWorktreeRemove(false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(events, [`git worktree remove ${worktree}`]);
});

caseTest('worktree-remove stops managed servers before removal and preserves the tree on stop failure', PROCESS, () => {
  const stopped = runWorktreeRemove(true);
  assert.equal(stopped.result.status, 0, stopped.result.stdout + stopped.result.stderr);
  assert.deepEqual(stopped.events, [
    `stop -C ${stopped.worktree} orm-test-servers-stop`,
    `git worktree remove ${stopped.worktree}`,
  ]);

  const failed = runWorktreeRemove(true, 17);
  assert.notEqual(failed.result.status, 0, failed.result.stdout + failed.result.stderr);
  assert.deepEqual(failed.events, [`stop -C ${failed.worktree} orm-test-servers-stop`]);
});
