// Helpers of the tests of the gates: a Git checkout in a temporary directory that holds the tools of scripts/kit, the
// configuration and the checklist of the fixture, and a bare repository as its remote `origin`.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FIXTURE = path.join(HERE, 'fixture');

export const CHECKLIST = 'docs/plans/execution-checklist.md';
export const TRANSLATION = 'docs/plans/execution-checklist.ko.md';

export function run(cwd, command, args, options = {}) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
}

export function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Commits the index as it is and returns the commit. */
export function commitIndex(cwd, message) {
  git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** Commits every change of the working tree and returns the commit. */
export function commitAll(cwd, message) {
  git(cwd, 'add', '--all');
  return commitIndex(cwd, message);
}

/** The checklist of the fixture with the first task in the state `state`, in English and in Korean. */
export function checklists(state) {
  const read = name => readFileSync(path.join(FIXTURE, name), 'utf8');
  const set = text => text.replace(/(\| T1-1 \|[^\n]*)\| \[ \] \|/, `$1| ${state} |`);
  return { english: set(read(CHECKLIST)), korean: set(read(TRANSLATION)) };
}

/**
 * A checkout `work` with scripts/kit, config/checklist.json (or `config`), the checklists in the state `state` (the second
 * task of the fixture) and the files of `files`, written over them, and the remote `origin` in `remote`; nothing is committed.
 * Removed with `t.after`.
 */
export function checkout(t, { state = '[ ]', config = null, files = {} } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'kit-gates-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const work = path.join(directory, 'work');
  const remote = path.join(directory, 'remote.git');
  mkdirSync(work);
  cpSync(path.join(ROOT, 'scripts/kit'), path.join(work, 'scripts/kit'), { recursive: true });
  mkdirSync(path.join(work, 'config'));
  cpSync(path.join(FIXTURE, 'config/checklist.json'), path.join(work, 'config/checklist.json'));
  if (config) writeFileSync(path.join(work, 'config/checklist.json'), JSON.stringify(config));
  mkdirSync(path.join(work, 'docs/plans'), { recursive: true });
  const { english, korean } = checklists(state);
  writeFileSync(path.join(work, CHECKLIST), english);
  writeFileSync(path.join(work, TRANSLATION), korean);
  writeFileSync(path.join(work, '.gitignore'), '/var/\n');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    writeFileSync(path.join(work, name), text);
  }
  git(directory, 'init', '--quiet', '--bare', remote);
  git(directory, 'init', '--quiet', '--initial-branch=main', work);
  git(work, 'remote', 'add', 'origin', remote);
  return { work, remote };
}

/** A checkout with the hooks installed through `git-hooks install` and everything committed. */
export function prepared(t, options) {
  const made = checkout(t, options);
  const installed = run(made.work, process.execPath, ['scripts/kit/git-hooks.mjs', 'install']);
  if (installed.status !== 0) throw new Error(`git-hooks install failed: ${installed.stderr}`);
  commitAll(made.work, 'checklist');
  return made;
}
