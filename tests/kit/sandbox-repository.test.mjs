// The Git repositories of the test sandboxes (tests/kit/sandbox-repository.mjs). A git command in a sandbox starts no
// background process that outlives it, so the removal of the sandbox meets no entry that such a process creates. The git
// commands are traced through GIT_TRACE2_EVENT, which records each child process that a git command starts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeSandbox } from './sandbox-cleanup.mjs';
import { initRepository } from './sandbox-repository.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A temporary directory, removed with `t.after`. */
function sandbox(t, prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => removeSandbox(directory));
  return directory;
}

/** Runs git in `cwd` with the trace of every git process appended to `trace`; fails on a nonzero status. */
function git(cwd, trace, ...args) {
  const env = { ...process.env, GIT_TRACE2_EVENT: trace };
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

/** The argument lists of the child processes that the traced git commands started. */
function children(trace) {
  return readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.event === 'child_start').map(event => event.argv.join(' '));
}

/** The children that run maintenance: `git maintenance run --auto --detach` and `git gc --auto` detach from the command. */
const maintenance = (trace) => children(trace).filter(argv => /^git (maintenance|gc)\b/.test(argv));

/** A sandbox repository with files added. */
function filled(t, trace) {
  const root = sandbox(t, 'kit-sandbox-repository-');
  initRepository(root);
  for (let index = 0; index < 3; index += 1) writeFileSync(path.join(root, `file-${index}.txt`), `${index}\n`);
  git(root, trace, 'add', '-A');
  return root;
}

test('a commit in a sandbox repository starts no git maintenance that outlives it', (t) => {
  const trace = path.join(sandbox(t, 'kit-sandbox-trace-'), 'trace.json');
  const root = filled(t, trace);
  git(root, trace, 'commit', '--quiet', '-m', 'files');
  assert.deepEqual(maintenance(trace), []);
});

test('a push into a bare sandbox repository starts no git maintenance there', (t) => {
  const trace = path.join(sandbox(t, 'kit-sandbox-trace-'), 'trace.json');
  const root = filled(t, trace);
  const remote = path.join(sandbox(t, 'kit-sandbox-remote-'), 'remote.git');
  initRepository(remote, '--bare');
  git(root, trace, 'commit', '--quiet', '-m', 'files');
  git(root, trace, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
  assert.ok(children(trace).some(argv => argv.includes('receive-pack')), 'the push is traced through the receiving side');
  assert.deepEqual(maintenance(trace), []);
});

test('every Git repository of the kit tests is created through initRepository', () => {
  const callers = readdirSync(HERE).filter(name => name.endsWith('.mjs') && name !== 'sandbox-repository.mjs' && name !== 'sandbox-repository.test.mjs')
    .filter(name => /['"]init['"]/.test(readFileSync(path.join(HERE, name), 'utf8')));
  assert.deepEqual(callers, [], 'these files run git init themselves');
});
