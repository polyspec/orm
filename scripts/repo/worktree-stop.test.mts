import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { isolatedEnvironment } from '../../tests/environment.mts';
import { stopTargetOf } from '../../node_modules/@polyspec/kit/scripts/kit/land.mts';
import { prune } from '../../node_modules/@polyspec/kit/scripts/kit/worktree-prune.mts';

const root = resolve(import.meta.dirname, '../..');

function run(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, env: isolatedEnvironment(), encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

function withIsolatedEnvironment<T>(body: () => T): T {
  const env = isolatedEnvironment();
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  try {
    return body();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

function fixture(fails: boolean): { base: string; repo: string; folder: string; data: string; log: string; bin: string } {
  const base = mkdtempSync(join(tmpdir(), 'orm-worktree-stop-'));
  try {
    const repo = join(base, 'repo');
    const folder = join(base, 'repo-feature');
    mkdirSync(repo);
    run(repo, 'git', ['init', '-b', 'main']);
    run(repo, 'git', ['config', 'user.name', 'Test']);
    run(repo, 'git', ['config', 'user.email', 'test@example.invalid']);
    const data = join(folder, '.runtime', 'servers');
    const log = join(base, 'events');
    writeFileSync(join(repo, 'Makefile'), `WORKTREE_STOP = orm-test-servers-stop\n.PHONY: orm-test-servers-stop\norm-test-servers-stop:\n\t@echo stop >> '${log}'\n\t@test "$$\{GROUP:-}" != poison\n\t@test "$$\{ORM_CHECK_RUN_ID:-}" != poison\n\t@${fails ? 'exit 7' : `mkdir -p '${data}' && echo stopped > '${data}/state'`}\n`);
    writeFileSync(join(repo, '.gitignore'), '.runtime/\n');
    writeFileSync(join(repo, 'seed'), 'seed');
    run(repo, 'git', ['add', '.']);
    run(repo, 'git', ['commit', '-m', 'seed']);
    run(repo, 'git', ['worktree', 'add', '-b', 'feature', folder, 'main']);
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'state'), 'running');
    writeFileSync(join(folder, 'change'), 'change');
    run(folder, 'git', ['add', 'change']);
    run(folder, 'git', ['commit', '-m', 'feature']);
    run(repo, 'git', ['merge', '--ff-only', 'feature']);
    const bin = join(base, 'bin');
    mkdirSync(bin);
    for (const name of ['ps', 'lsof']) {
      const file = join(bin, name);
      writeFileSync(file, '#!/bin/sh\nexit 0\n');
      chmodSync(file, 0o755);
    }
    return { base, repo, folder, data, log, bin };
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    throw error;
  }
}

function withFixture<T>(fails: boolean, body: (value: ReturnType<typeof fixture>) => T): T {
  const value = fixture(fails);
  try {
    return body(value);
  } finally {
    rmSync(value.base, { recursive: true, force: true });
  }
}

test('the kit make database reads the ORM Makefile-origin stop target', { timeout: 10_000 }, () => {
  assert.deepEqual(withIsolatedEnvironment(() => stopTargetOf(root)), ['orm-test-servers-stop']);
  assert.match(readFileSync(join(root, 'Makefile'), 'utf8'), /^WORKTREE_STOP = orm-test-servers-stop$/m);
});

test('kit cleanup stops servers before removing a merged worktree', { timeout: 10_000 }, () => {
  withFixture(false, value => {
    const events: string[] = [];
    const previousPath = process.env.PATH;
    process.env.PATH = `${value.bin}:${previousPath}`;
    try {
      withIsolatedEnvironment(() => prune(value.repo, { print: (line: string) => events.push(line) }));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const stopped = events.findIndex(line => line.startsWith('orm-test-servers-stop passed'));
    const removed = events.findIndex(line => line.startsWith('removed the worktree'));
    assert.ok(stopped >= 0, 'the kit cleanup reports the stop target passed');
    assert.ok(removed >= 0, 'the kit cleanup reports the worktree removed');
    assert.ok(stopped < removed, 'the stop target passes before the worktree is removed');
    assert.deepEqual(readFileSync(value.log, 'utf8').trim().split('\n'), ['stop']);
    assert.equal(existsSync(value.folder), false);
  });
});

test('kit cleanup drops caller variables and keeps worktree data when stop fails', { timeout: 10_000 }, () => {
  withFixture(true, value => {
    const previousPath = process.env.PATH;
    const previousGroup = process.env.GROUP;
    const previousRunId = process.env.ORM_CHECK_RUN_ID;
    process.env.PATH = `${value.bin}:${previousPath}`;
    process.env.GROUP = 'poison';
    process.env.ORM_CHECK_RUN_ID = 'poison';
    try {
      withIsolatedEnvironment(() => assert.throws(
        () => prune(value.repo, { print: () => {} }),
        /stop target orm-test-servers-stop failed.*worktree is kept/s,
      ));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousGroup === undefined) delete process.env.GROUP;
      else process.env.GROUP = previousGroup;
      if (previousRunId === undefined) delete process.env.ORM_CHECK_RUN_ID;
      else process.env.ORM_CHECK_RUN_ID = previousRunId;
    }
    assert.equal(existsSync(value.folder), true);
    assert.equal(existsSync(value.data), true);
    assert.deepEqual(readFileSync(value.log, 'utf8').trim().split('\n'), ['stop']);
  });
});
