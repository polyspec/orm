#!/usr/bin/env node
// The guard of the full suite. The make target of a repository that runs the suite starts it before any step:
//
//   node scripts/kit/full-run.mjs run [--key name=value]... <target>...   run every make target of the full suite
//   node scripts/kit/full-run.mjs rerun-failed [--key name=value]...      rerun the targets of the current tree that did not pass
//
// The full suite runs once per tree, when no item of a tracker of config/checklist.json is in its active state. The guard
// refuses a run while such an item exists or a tracker cannot be read, while the Git hooks are not installed
// (git-hooks.mjs), while tracked files have uncommitted changes or untracked files are not ignored (the record names the
// tree, which holds neither), and while the run of another process is still going on. A full run is refused when
// var/full-run.json already records a run of the current tree (`git rev-parse HEAD^{tree}`) with the same keys;
// `rerun-failed` is refused unless that record exists, names the current tree and the same keys, and has targets that did
// not pass. A key (`--key name=value`) is a further input of the run, such as the commit of a dependency, that the record
// names beside the tree. The guard holds the lock var/full-run.lock (holder-lock.mjs) from its first read to its last write.
//
// The guard prints its decision with the reason, runs each target with `make -k <target>` to its end, prints its start and
// its result with the elapsed time, and writes the record before and after each target, so a run that is stopped stays
// recorded as `incomplete`. The output of each target goes to var/report/full-run/targets/<target>.log, and a failed target
// keeps its last output lines in the record. No step has a time limit.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inspectTrackers, loadConfig } from './checklist.mjs';
import { hooksIssue } from './git-hooks.mjs';
import { acquireHolderLock, HolderLockRefused, holderRunning, processStart } from './holder-lock.mjs';
import { FAILURE_LINES, logPath, runLogged, startReport, TARGET_NAME, targetPassed } from './target-report.mjs';
import { isMain, ROOT } from './paths.mjs';
import { readJson, writeJson } from './files.mjs';
import { git } from './git.mjs';
import { now, seconds } from './time.mjs';

const USAGE = 'Usage: node scripts/kit/full-run.mjs run [--key name=value]... <target>... | rerun-failed [--key name=value]...';
// The record of the last full run of this checkout; /var/ is ignored by Git.
export const RECORD = 'var/full-run.json';
export const LOCK = 'var/full-run.lock';
export const REPORT = 'var/report/full-run';
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

const notPassed = record => record.targets.filter(target => target.status !== 'passed').map(target => target.name);
const describeKeys = keys => (Object.keys(keys).length === 0 ? 'no keys' : Object.entries(keys).map(([name, value]) => `${name}=${value}`).join(', '));
const sameKeys = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Decides whether the guard runs. `mode` is `run` or `rerun-failed`; `keys` the keys of this run; `active` the items in an
 * active state as `{ file, id, title }`; `problems` why a tracker cannot be read; `hooks` why the Git hooks are not
 * installed, or null; `dirty` the `git status --porcelain` lines; `tree` the current tree; `record` the record of the last
 * run or null; `running` whether the holder of an incomplete record still runs. Returns `{ run, reason, targets }`.
 */
export function decide({ mode, targets = [], keys = {}, active = [], problems = [], hooks = null, dirty = [], tree, record = null, running = false }) {
  const refuse = reason => ({ run: false, reason, targets: [] });
  if (problems.length > 0) return refuse(`the trackers of config/checklist.json cannot be read, so no item is known to be out of its active state:\n${problems.map(line => `  ${line}`).join('\n')}`);
  if (active.length > 0) {
    return refuse(`${plural(active.length, 'item')} in an active state; the full suite runs once, when every item is out of its active state:\n${active.map(item => `  ${item.file} ${item.id} ${item.title}`).join('\n')}`);
  }
  if (hooks) return refuse(`the Git hooks are not installed: ${hooks}`);
  if (dirty.length > 0) {
    return refuse(`the working tree has uncommitted tracked changes or untracked files that are not ignored; a full run verifies a committed tree; commit them, or remove or ignore an untracked file:\n${dirty.map(line => `  ${line}`).join('\n')}`);
  }
  if (record && running) return refuse(`the run started ${record.started} by process ${record.pid} is still running on tree ${record.tree}`);
  const sameTree = record?.tree === tree;
  if (mode === 'run') {
    if (record && sameTree && sameKeys(record.keys, keys)) {
      const open = notPassed(record);
      const rerun = open.length > 0 ? `; rerun-failed reruns its targets that did not pass: ${open.join(', ')}` : '';
      return refuse(`the full run of tree ${tree} (commit ${record.commit}) with ${describeKeys(keys)} started ${record.started} with result ${record.result}; the full suite runs once per tree and keys${rerun}`);
    }
    const before = !record
      ? `no full-run record in ${RECORD} for tree ${tree}`
      : !sameTree
        ? `tree ${tree} differs from the tree ${record.tree} of the last full run (result ${record.result}, started ${record.started})`
        : `the keys (${describeKeys(keys)}) differ from the keys (${describeKeys(record.keys ?? {})}) of the last full run of tree ${tree} (result ${record.result}, started ${record.started})`;
    return { run: true, reason: `${before}; no item in an active state; ${plural(targets.length, 'target')}`, targets };
  }
  if (!record) return refuse(`no full-run record in ${RECORD}; rerun-failed reruns the targets of a full run of the current tree that did not pass`);
  if (!sameTree) return refuse(`the last full run (started ${record.started}) verified tree ${record.tree}, not the current tree ${tree}; rerun-failed reruns only targets of the current tree`);
  if (!sameKeys(record.keys, keys)) return refuse(`the last full run (started ${record.started}) had the keys (${describeKeys(record.keys ?? {})}), not (${describeKeys(keys)}); rerun-failed reruns only targets of the current keys`);
  const open = notPassed(record);
  if (open.length === 0) return refuse(`the full run of tree ${tree} started ${record.started} passed; no target failed`);
  return { run: true, reason: `the full run of tree ${tree} started ${record.started} has ${plural(open.length, 'target')} that did not pass: ${open.join(', ')}`, targets: open };
}

function readRecord(root) {
  const file = path.join(root, RECORD);
  return existsSync(file) ? readJson(file) : null;
}

// The record is written to a file of this process and renamed, so a reader never sees a partial record.
const writeRecord = (root, record) => writeJson(path.join(root, RECORD), record);

/**
 * Runs `make -k <target>` in `root` through the same runner as the CI report (target-report.mjs `runLogged`): its output goes
 * to the terminal as complete lines and to the log of the target in `directory`. Resolves `{ passed, lastLines }`: whether make
 * ended with status 0, and the last FAILURE_LINES lines of its output in the order of arrival. A failed write of the log throws.
 */
async function runMakeTarget(root, target, directory) {
  if (!TARGET_NAME.test(target)) throw new Error(`the target name ${JSON.stringify(target)} does not match ${TARGET_NAME}`);
  const writer = { errors: [] };
  const { lines, exit } = await runLogged({ root, target, log: logPath(directory, target), writer, output: (text, stream) => process[stream].write(text) });
  if (writer.errors.length) throw new Error(writer.errors.join('; '));
  return { passed: targetPassed(target, exit), lastLines: lines.slice(-FAILURE_LINES) };
}

/**
 * Inspects the checkout, decides and runs. `runTarget(name)` resolves `{ passed, lastLines }` of a target. Returns the exit
 * status: 0 when the full result of the tree is passed, 1 otherwise.
 */
export async function fullRun({ root, mode, targets = [], keys = {}, runTarget = name => runMakeTarget(root, name, path.join(root, REPORT)), print = line => console.log(line) }) {
  let held;
  try {
    held = acquireHolderLock(path.join(root, LOCK), { checkout: root, command: `full-run ${mode}` });
  } catch (error) {
    if (!(error instanceof HolderLockRefused)) throw error;
    print(`[full-run] refuse: ${error.message}; the guard of another run reads or writes ${RECORD}`);
    return 1;
  }
  try {
    return await guardedRun({ root, mode, targets, keys, runTarget, print });
  } finally {
    held.release();
  }
}

// Decides and runs while the guard holds the lock of the record.
async function guardedRun({ root, mode, targets, keys, runTarget, print }) {
  const config = loadConfig(root);
  const found = inspectTrackers(config, file => readFileSync(path.join(root, file), 'utf8'));
  const dirty = git(root, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
  const tree = git(root, 'rev-parse', 'HEAD^{tree}').trim();
  const commit = git(root, 'rev-parse', 'HEAD').trim();
  const record = readRecord(root);
  const running = Boolean(record && record.result === 'incomplete' && record.pid !== process.pid && holderRunning({ pid: record.pid, processStart: record.processStart }));
  const decision = decide({ mode, targets, keys, active: found.active, problems: found.problems, hooks: hooksIssue(root, config.hooks), dirty, tree, record, running });
  print(`[full-run] ${decision.run ? 'run' : 'refuse'}: ${decision.reason}`);
  if (!decision.run) return 1;

  const own = { pid: process.pid, processStart: processStart(process.pid) };
  const current = mode === 'run'
    ? { tree, commit, keys, result: 'incomplete', ...own, started: now(), ended: null, targets: targets.map(name => ({ name, status: 'pending' })), reruns: [] }
    : { ...record, result: 'incomplete', ...own };
  const rerun = mode === 'run' ? null : { started: now(), ended: null, targets: decision.targets, result: 'incomplete' };
  if (rerun) current.reruns.push(rerun);
  writeRecord(root, current);
  if (mode === 'run') startReport(path.join(root, REPORT));

  const begin = Date.now();
  for (const [index, name] of decision.targets.entries()) {
    const target = current.targets.find(entry => entry.name === name);
    Object.assign(target, { status: 'running', started: now(), ended: null, elapsedMs: null });
    delete target.lastLines;
    writeRecord(root, current);
    print(`[full-run] start ${name} (${index + 1}/${decision.targets.length})`);
    const targetBegin = Date.now();
    const { passed, lastLines } = await runTarget(name);
    Object.assign(target, { status: passed ? 'passed' : 'failed', ended: now(), elapsedMs: Date.now() - targetBegin });
    if (!passed) target.lastLines = lastLines;
    writeRecord(root, current);
    print(`[full-run] ${name} ${target.status} in ${seconds(target.elapsedMs)}`);
    // The cause of a failure stands with its result.
    if (!passed) print(`[full-run] ${name} failed; its last ${plural(lastLines.length, 'line')}:\n${lastLines.map(line => `  | ${line}`).join('\n')}`);
  }

  const failed = current.targets.filter(target => target.status === 'failed').map(target => target.name);
  current.result = failed.length === 0 ? 'passed' : 'failed';
  current.failed = failed;
  current.ended = now();
  if (rerun) Object.assign(rerun, { ended: current.ended, result: decision.targets.every(name => !failed.includes(name)) ? 'passed' : 'failed' });
  writeRecord(root, current);
  const summary = `${decision.targets.filter(name => !failed.includes(name)).length} of ${decision.targets.length} targets passed in ${seconds(Date.now() - begin)}`;
  print(failed.length === 0
    ? `[full-run] result passed for tree ${tree}: ${summary}`
    : `[full-run] result failed for tree ${tree}: ${summary}; failed: ${failed.join(', ')}; rerun-failed reruns them`);
  return failed.length === 0 ? 0 : 1;
}

/** The mode, the keys and the targets of the arguments of the command line; throws the usage when they do not fit. */
export function parseArguments(args) {
  const [mode, ...rest] = args;
  const keys = {};
  const targets = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--key') {
      const [name, ...value] = (rest[index + 1] ?? '').split('=');
      if (!KEY_NAME.test(name) || value.length === 0 || value.join('=') === '') throw new Error(`--key takes name=value, with a name of letters, digits, _ and -; got ${JSON.stringify(rest[index + 1])}`);
      if (name in keys) throw new Error(`--key ${name} is given twice`);
      keys[name] = value.join('=');
      index += 1;
    } else if (TARGET_NAME.test(rest[index]) && !targets.includes(rest[index])) {
      targets.push(rest[index]);
    } else {
      throw new Error(`${JSON.stringify(rest[index])} is not a target name that is given once (${TARGET_NAME})`);
    }
  }
  if (!((mode === 'run' && targets.length > 0) || (mode === 'rerun-failed' && targets.length === 0))) throw new Error(USAGE);
  return { mode, keys, targets };
}

if (isMain(import.meta.url)) {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message === USAGE ? USAGE : `${error.message}\n${USAGE}`);
    process.exit(2);
  }
  try {
    process.exitCode = await fullRun({ root: ROOT, ...parsed });
  } catch (error) {
    console.error(`[full-run] failed: ${error.message}`);
    process.exitCode = 1;
  }
}
