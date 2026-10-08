// Tests of the guard of the full suite (scripts/kit/full-run.mjs): it refuses while an item is in an active state, while a
// tracker cannot be read, while the hooks are not installed, while the tree is not committed and when the current tree and
// keys have a record; it records each target as the run proceeds; and `rerun-failed` reruns only the targets of the current
// tree that did not pass. The targets of the API tests are stubs; the command tests run a stub `make` on PATH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LOCK, RECORD, REPORT, decide, fullRun, parseArguments } from '../../scripts/kit/full-run.mjs';
import { processStart } from '../../scripts/kit/holder-lock.mjs';
import { CHECKLIST, TRANSLATION, commitAll, git, prepared, run } from './gates-checkout.mjs';

const record = work => JSON.parse(readFileSync(path.join(work, RECORD), 'utf8'));
const edit = (work, file, change) => writeFileSync(path.join(work, file), change(readFileSync(path.join(work, file), 'utf8')));
const start = (work) => {
  for (const file of [CHECKLIST, TRANSLATION]) edit(work, file, text => text.replace(/(\| T1-1 \|[^\n]*)\| \[ \] \|/, '$1| [~] |'));
};

// Runs the guard with stub targets that pass unless they are named in `failing`; returns the exit status, the printed lines
// and the targets that ran. A stub checks that the record names it as running while it runs.
async function guard(work, mode, targets, { failing = [], keys = {} } = {}) {
  const lines = [];
  const ran = [];
  const status = await fullRun({
    root: work,
    mode,
    targets,
    keys,
    print: line => lines.push(line),
    runTarget: async (name) => {
      const current = record(work);
      assert.equal(current.result, 'incomplete');
      assert.equal(current.targets.find(target => target.name === name).status, 'running');
      assert.equal(existsSync(path.join(work, LOCK)), true, 'the guard does not hold its lock while a target runs');
      ran.push(name);
      return { passed: !failing.includes(name), lastLines: failing.includes(name) ? [`${name} output 1`, `${name} output 2`] : [] };
    },
  });
  return { status, output: lines.join('\n'), ran };
}

const EARLIER = { tree: 'tree-1', commit: 'c1', keys: {}, result: 'passed', started: '2026-10-05T01:00:00.000Z', targets: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'passed' }] };
const CLEAN = { mode: 'run', targets: ['a', 'b'], tree: 'tree-1' };

test('the arguments are a mode, keys and make target names that are given once', () => {
  assert.deepEqual(parseArguments(['run', '--key', 'dep=v1.2.3', 'a', 'b-c']), { mode: 'run', keys: { dep: 'v1.2.3' }, targets: ['a', 'b-c'] });
  assert.deepEqual(parseArguments(['rerun-failed', '--key', 'url=a=b']), { mode: 'rerun-failed', keys: { url: 'a=b' }, targets: [] });
  assert.throws(() => parseArguments(['run']), /Usage: node scripts\/kit\/full-run\.mjs run/);
  assert.throws(() => parseArguments(['rerun-failed', 'a']), /Usage:/);
  assert.throws(() => parseArguments(['run', 'a', 'a']), /"a" is not a target name that is given once/);
  assert.throws(() => parseArguments(['run', 'a b']), /"a b" is not a target name/);
  assert.throws(() => parseArguments(['run', '--key', 'dep', 'a']), /--key takes name=value/);
  assert.throws(() => parseArguments(['run', '--key', 'dep=', 'a']), /--key takes name=value/);
  assert.throws(() => parseArguments(['run', '--key', 'dep=1', '--key', 'dep=2', 'a']), /--key dep is given twice/);
  assert.throws(() => parseArguments(['check', 'a']), /Usage:/);
});

test('the decision refuses an active item, an unreadable tracker, missing hooks, a dirty tree and a second run of a tree', () => {
  const fresh = decide(CLEAN);
  assert.equal(fresh.run, true);
  assert.deepEqual(fresh.targets, ['a', 'b']);
  assert.match(fresh.reason, /no full-run record in var\/full-run\.json for tree tree-1; no item in an active state; 2 targets/);

  const active = decide({ ...CLEAN, active: [{ file: 'docs/c.md', id: 'T1.2', title: 'Print a union' }] });
  assert.equal(active.run, false);
  assert.match(active.reason, /^1 item in an active state; the full suite runs once, when every item is out of its active state:\n  docs\/c\.md T1\.2 Print a union$/);

  const problems = decide({ ...CLEAN, problems: ['docs/c.md: it has no item'] });
  assert.match(problems.reason, /cannot be read[\s\S]*docs\/c\.md: it has no item/);

  const hooks = decide({ ...CLEAN, hooks: 'core.hooksPath is not set; run make hooks' });
  assert.match(hooks.reason, /the Git hooks are not installed: core\.hooksPath is not set; run make hooks/);
  assert.equal(decide({ ...CLEAN, mode: 'rerun-failed', hooks: 'x' }).run, false);

  const dirty = decide({ ...CLEAN, dirty: [' M a.txt', '?? b.txt'] });
  assert.equal(dirty.run, false);
  assert.match(dirty.reason, /uncommitted tracked changes or untracked files that are not ignored[\s\S]*M a\.txt\n {2}\?\? b\.txt/);

  const second = decide({ ...CLEAN, record: EARLIER });
  assert.equal(second.run, false);
  assert.match(second.reason, /full run of tree tree-1 \(commit c1\) with no keys started 2026-10-05T01:00:00\.000Z with result passed; the full suite runs once per tree and keys$/);

  const changed = decide({ ...CLEAN, tree: 'tree-2', record: EARLIER });
  assert.equal(changed.run, true);
  assert.match(changed.reason, /tree tree-2 differs from the tree tree-1 of the last full run/);
  assert.equal(decide({ ...CLEAN, tree: 'tree-2', record: EARLIER, active: [{ file: 'f', id: 'T', title: 'x' }] }).run, false);

  const running = decide({ ...CLEAN, tree: 'tree-2', record: { ...EARLIER, result: 'incomplete', pid: 42 }, running: true });
  assert.equal(running.run, false);
  assert.match(running.reason, /process 42 is still running on tree tree-1/);
});

test('the keys are inputs of the run beside the tree: other keys allow a run of the same tree', () => {
  const keyed = { ...EARLIER, keys: { dep: 'c1' } };
  const same = decide({ ...CLEAN, keys: { dep: 'c1' }, record: keyed });
  assert.equal(same.run, false);
  assert.match(same.reason, /with dep=c1 started/);
  const other = decide({ ...CLEAN, keys: { dep: 'c2' }, record: keyed });
  assert.equal(other.run, true);
  assert.match(other.reason, /the keys \(dep=c2\) differ from the keys \(dep=c1\) of the last full run of tree tree-1/);
  assert.equal(decide({ ...CLEAN, keys: {}, record: keyed }).run, true, 'a run without keys is not the run with keys');
  const rerun = decide({ ...CLEAN, mode: 'rerun-failed', keys: { dep: 'c2' }, targets: [], record: { ...keyed, result: 'failed', targets: [{ name: 'a', status: 'failed' }] } });
  assert.equal(rerun.run, false);
  assert.match(rerun.reason, /had the keys \(dep=c1\), not \(dep=c2\)/);
});

test('the decision of rerun-failed needs a record of the current tree with targets that did not pass', () => {
  const rerun = { mode: 'rerun-failed', targets: [], tree: 'tree-1' };
  assert.match(decide(rerun).reason, /no full-run record/);
  const failed = { ...EARLIER, result: 'failed', targets: [{ name: 'a', status: 'passed' }, { name: 'b', status: 'failed' }, { name: 'c', status: 'pending' }, { name: 'd', status: 'running' }] };
  assert.match(decide({ ...rerun, tree: 'tree-2', record: failed }).reason, /verified tree tree-1, not the current tree tree-2/);
  assert.deepEqual(decide({ ...rerun, record: failed }).targets, ['b', 'c', 'd']);
  assert.match(decide({ ...rerun, record: EARLIER }).reason, /passed; no target failed/);
  assert.equal(decide({ ...rerun, record: failed, dirty: [' M x'] }).run, false);
  assert.equal(decide({ ...rerun, record: failed, active: [{ file: 'f', id: 'T', title: 'x' }] }).run, false);
});

test('an item in an active state refuses the run before any target, naming its file and ID', async (t) => {
  const { work } = prepared(t, { state: '[~]' });
  const { status, output, ran } = await guard(work, 'run', ['a', 'b']);
  assert.equal(status, 1);
  assert.deepEqual(ran, []);
  assert.match(output, /^\[full-run\] refuse: 1 item in an active state[\s\S]*docs\/plans\/execution-checklist\.md T1-1 Print `a \\\| b` for a union/);
  assert.equal(existsSync(path.join(work, RECORD)), false);
  assert.equal(existsSync(path.join(work, LOCK)), false, 'a refusal leaves its lock');
});

test('a translation with another state, and a missing tracker, refuse the run', async (t) => {
  const { work } = prepared(t);
  edit(work, TRANSLATION, text => text.replace(/(\| T1-1 \|[^\n]*)\| \[ \] \|/, '$1| [o] |'));
  commitAll(work, 'translation differs');
  const twin = await guard(work, 'run', ['a']);
  assert.equal(twin.status, 1);
  assert.match(twin.output, /cannot be read[\s\S]*T1-1 is \[ \] in docs\/plans\/execution-checklist\.md and \[o\] in docs\/plans\/execution-checklist\.ko\.md/);
  git(work, 'rm', '--quiet', '-f', CHECKLIST);
  commitAll(work, 'remove the checklist');
  const missing = await guard(work, 'run', ['a']);
  assert.match(missing.output, /cannot be read[\s\S]*docs\/plans\/execution-checklist\.md: ENOENT/);
  assert.deepEqual(missing.ran, []);
});

test('a checkout without installed hooks is refused before any target', async (t) => {
  const { work } = prepared(t);
  git(work, 'config', '--unset', 'core.hooksPath');
  const { status, output, ran } = await guard(work, 'run', ['a']);
  assert.equal(status, 1);
  assert.deepEqual(ran, []);
  assert.match(output, /^\[full-run\] refuse: the Git hooks are not installed: core\.hooksPath is not set/);
});

test('a changed tracked file and an untracked file that is not ignored are refused; an ignored file is not', async (t) => {
  const { work } = prepared(t);
  edit(work, '.gitignore', text => `${text}/build/\n`);
  const changed = await guard(work, 'run', ['a']);
  assert.equal(changed.status, 1);
  assert.match(changed.output, /uncommitted tracked changes[\s\S]*M \.gitignore/);
  commitAll(work, 'ignore build');
  writeFileSync(path.join(work, 'notes.txt'), 'x\n');
  const untracked = await guard(work, 'run', ['a']);
  assert.match(untracked.output, /untracked files that are not ignored[\s\S]*\?\? notes\.txt/);
  assert.deepEqual(untracked.ran, []);
  writeFileSync(path.join(work, 'notes.txt'), '');
  git(work, 'clean', '--quiet', '-f');
  mkdirSync(path.join(work, 'build'));
  writeFileSync(path.join(work, 'build/out.txt'), 'x\n');
  const ignored = await guard(work, 'run', ['a']);
  assert.equal(ignored.status, 0, ignored.output);
});

test('a full run records each target, and the same tree is refused a second time', async (t) => {
  const { work } = prepared(t);
  const first = await guard(work, 'run', ['a', 'b', 'c']);
  assert.equal(first.status, 0, first.output);
  assert.deepEqual(first.ran, ['a', 'b', 'c']);
  assert.match(first.output, /^\[full-run\] run: no full-run record/);
  assert.match(first.output, /\[full-run\] result passed for tree [0-9a-f]{40}: 3 of 3 targets passed in /);
  const written = record(work);
  assert.equal(written.tree, git(work, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(written.commit, git(work, 'rev-parse', 'HEAD'));
  assert.equal(written.result, 'passed');
  assert.deepEqual(written.keys, {});
  assert.equal(written.pid, process.pid);
  assert.equal(written.processStart, processStart(process.pid));
  assert.ok(written.ended);
  assert.deepEqual(written.targets.map(target => target.status), ['passed', 'passed', 'passed']);
  assert.equal(existsSync(path.join(work, LOCK)), false, 'the lock stayed after the run');

  const second = await guard(work, 'run', ['a', 'b', 'c']);
  assert.equal(second.status, 1);
  assert.deepEqual(second.ran, []);
  assert.match(second.output, new RegExp(`refuse: the full run of tree ${written.tree} \\(commit ${written.commit}\\) with no keys started ${written.started} with result passed`));

  writeFileSync(path.join(work, 'next.txt'), 'next\n');
  commitAll(work, 'next');
  const changed = await guard(work, 'run', ['a']);
  assert.equal(changed.status, 0, changed.output);
  assert.match(changed.output, /differs from the tree/);
});

test('a failed target keeps its last lines in the record and in the output, and the run result is failed', async (t) => {
  const { work } = prepared(t);
  const { status, output, ran } = await guard(work, 'run', ['a', 'b', 'c'], { failing: ['b'] });
  assert.equal(status, 1);
  assert.deepEqual(ran, ['a', 'b', 'c'], 'a failed target does not stop the run');
  assert.match(output, /\[full-run\] b failed; its last 2 lines:\n {2}\| b output 1\n {2}\| b output 2/);
  assert.match(output, /result failed for tree [0-9a-f]{40}: 2 of 3 targets passed in .*; failed: b; rerun-failed reruns them/);
  const written = record(work);
  assert.equal(written.result, 'failed');
  assert.deepEqual(written.failed, ['b']);
  assert.deepEqual(written.targets.find(target => target.name === 'b').lastLines, ['b output 1', 'b output 2']);
  assert.equal('lastLines' in written.targets.find(target => target.name === 'a'), false);
});

test('rerun-failed without a record is refused', async (t) => {
  const { work } = prepared(t);
  const { status, output, ran } = await guard(work, 'rerun-failed', []);
  assert.equal(status, 1);
  assert.deepEqual(ran, []);
  assert.match(output, /refuse: no full-run record/);
});

test('rerun-failed reruns only the failed targets, and a passing rerun completes the result', async (t) => {
  const { work } = prepared(t);
  const first = await guard(work, 'run', ['a', 'b', 'c'], { failing: ['b'] });
  assert.equal(first.status, 1);

  const failing = await guard(work, 'rerun-failed', [], { failing: ['b'] });
  assert.equal(failing.status, 1);
  assert.deepEqual(failing.ran, ['b']);
  assert.equal(record(work).result, 'failed');

  const passing = await guard(work, 'rerun-failed', []);
  assert.equal(passing.status, 0, passing.output);
  assert.deepEqual(passing.ran, ['b']);
  const completed = record(work);
  assert.equal(completed.result, 'passed');
  assert.deepEqual(completed.failed, []);
  assert.deepEqual(completed.targets.map(target => target.status), ['passed', 'passed', 'passed']);
  assert.equal('lastLines' in completed.targets[1], false, 'a passed target keeps the lines of its failure');
  assert.deepEqual(completed.reruns.map(rerun => [rerun.targets, rerun.result]), [[['b'], 'failed'], [['b'], 'passed']]);

  const again = await guard(work, 'rerun-failed', []);
  assert.equal(again.status, 1);
  assert.match(again.output, /passed; no target failed/);
});

test('the keys of a run are recorded, and a rerun needs the same keys', async (t) => {
  const { work } = prepared(t);
  const first = await guard(work, 'run', ['a'], { failing: ['a'], keys: { dep: 'c1' } });
  assert.equal(first.status, 1);
  assert.deepEqual(record(work).keys, { dep: 'c1' });
  assert.match((await guard(work, 'rerun-failed', [], { keys: { dep: 'c2' } })).output, /had the keys \(dep=c1\), not \(dep=c2\)/);
  assert.match((await guard(work, 'run', ['a'], { keys: { dep: 'c1' } })).output, /the full suite runs once per tree and keys; rerun-failed reruns its targets that did not pass: a/);
  const other = await guard(work, 'run', ['a'], { keys: { dep: 'c2' } });
  assert.equal(other.status, 0, other.output);
  assert.deepEqual(record(work).keys, { dep: 'c2' });
});

test('a run that stops records the run as incomplete, and rerun-failed runs its unfinished targets', async (t) => {
  const { work } = prepared(t);
  await assert.rejects(fullRun({
    root: work,
    mode: 'run',
    targets: ['a', 'b', 'c'],
    print: () => {},
    runTarget: async (name) => {
      if (name === 'b') throw new Error('stopped');
      return { passed: true, lastLines: [] };
    },
  }), /stopped/);
  const stopped = record(work);
  assert.equal(stopped.result, 'incomplete');
  assert.deepEqual(stopped.targets.map(target => target.status), ['passed', 'running', 'pending']);
  assert.equal(existsSync(path.join(work, LOCK)), false, 'the lock stayed after a target that threw');
  // The process of the stopped run is this test process, which the guard does not take for another run.
  const second = await guard(work, 'run', ['a', 'b', 'c']);
  assert.equal(second.status, 1);
  assert.match(second.output, /with result incomplete/);
  const rerun = await guard(work, 'rerun-failed', []);
  assert.equal(rerun.status, 0, rerun.output);
  assert.deepEqual(rerun.ran, ['b', 'c']);
  assert.equal(record(work).result, 'passed');
});

test('an incomplete record whose process runs refuses the run; a reused process ID with another start time does not', async (t) => {
  const { work } = prepared(t);
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => other.kill());
  const stopped = { tree: 'tree-old', commit: 'c0', keys: {}, result: 'incomplete', pid: other.pid, processStart: processStart(other.pid), started: '2026-10-05T01:00:00.000Z', ended: null, targets: [{ name: 'a', status: 'running' }], reruns: [] };
  mkdirSync(path.join(work, 'var'), { recursive: true });
  writeFileSync(path.join(work, RECORD), JSON.stringify(stopped));
  const refused = await guard(work, 'run', ['a']);
  assert.equal(refused.status, 1);
  assert.match(refused.output, new RegExp(`refuse: the run started 2026-10-05T01:00:00\\.000Z by process ${other.pid} is still running on tree tree-old`));
  assert.deepEqual(refused.ran, []);

  writeFileSync(path.join(work, RECORD), JSON.stringify({ ...stopped, processStart: 'another start' }));
  const reused = await guard(work, 'run', ['a']);
  assert.equal(reused.status, 0, reused.output);
});

test('a guard is refused while another process holds the lock of the record, and runs no target', async (t) => {
  const { work } = prepared(t);
  const other = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => other.kill());
  mkdirSync(path.join(work, 'var'), { recursive: true });
  writeFileSync(path.join(work, LOCK), `${JSON.stringify({ checkout: work, pid: other.pid, processStart: processStart(other.pid), acquired: '2026-10-05T00:00:00.000Z', command: 'full-run run', token: 'other' })}\n`);
  const refused = await guard(work, 'run', ['a']);
  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.output, new RegExp(`^\\[full-run\\] refuse: .*full-run\\.lock is held by process ${other.pid} .*; the guard of another run reads or writes var/full-run\\.json$`, 'm'));
  assert.deepEqual(refused.ran, []);
  assert.equal(existsSync(path.join(work, RECORD)), false, 'the refused guard wrote the record');
  assert.equal(existsSync(path.join(work, LOCK)), true, 'the refused guard removed the lock of the other holder');
});

test('two guards that start together run the targets once: the second is refused with the holder', async (t) => {
  const { work } = prepared(t);
  const [first, second] = await Promise.all([guard(work, 'run', ['a', 'b']), guard(work, 'run', ['a', 'b'])]);
  assert.deepEqual([first.status, second.status], [0, 1]);
  assert.deepEqual([...first.ran, ...second.ran], ['a', 'b']);
  assert.match(second.output, /refuse: .*full-run\.lock is held by process/);
});

// A `make` on PATH that logs its arguments and the checkout, prints two lines, and fails for the targets named in FAIL.
function stubMake(work) {
  const bin = path.join(work, '..', 'bin');
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'make');
  writeFileSync(file, `#!/bin/sh
echo "$@" >> "${path.join(work, '..', 'make.log')}"
for target; do :; done
echo "building $target"
case " $FAIL " in *" $target "*) echo "error: $target broke" >&2; exit 2;; esac
printf 'no final newline of %s' "$target" >&2
`);
  chmodSync(file, 0o755);
  return bin;
}

test('the command runs make -k for each target, logs its output and exits 1 for a failed target', (t) => {
  const { work } = prepared(t);
  const bin = stubMake(work);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAIL: 'bad' };
  const failed = run(work, process.execPath, ['scripts/kit/full-run.mjs', 'run', '--key', 'dep=c1', 'good', 'bad'], { env });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(readFileSync(path.join(work, '..', 'make.log'), 'utf8'), '--no-print-directory -k good\n--no-print-directory -k bad\n');
  assert.match(failed.stdout, /\[full-run\] start good \(1\/2\)\nbuilding good\n/);
  assert.equal(failed.stderr, 'no final newline of good\nerror: bad broke\n', 'a standard error output without a final newline is followed by the next output at column 0');
  assert.match(failed.stdout, /\[full-run\] bad failed; its last 2 lines:\n {2}\| building bad\n {2}\| error: bad broke/);
  assert.match(readFileSync(path.join(work, REPORT, 'targets/good.log'), 'utf8'), /^make --no-print-directory -k good\nbuilding good\nno final newline of good\n\[report\] make good exited with status 0\n$/);
  assert.match(readFileSync(path.join(work, REPORT, 'targets/bad.log'), 'utf8'), /error: bad broke\n\[report\] make bad exited with status 2\n$/);
  const written = record(work);
  assert.deepEqual([written.keys, written.failed, written.targets.map(target => target.status)], [{ dep: 'c1' }, ['bad'], ['passed', 'failed']]);
  assert.deepEqual(written.targets[1].lastLines, ['building bad', 'error: bad broke']);

  const repeated = run(work, process.execPath, ['scripts/kit/full-run.mjs', 'run', '--key', 'dep=c1', 'good', 'bad'], { env });
  assert.equal(repeated.status, 1);
  assert.match(repeated.stdout, /refuse: the full run of tree/);

  const rerun = run(work, process.execPath, ['scripts/kit/full-run.mjs', 'rerun-failed', '--key', 'dep=c1'], { env: { ...env, FAIL: '' } });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(readFileSync(path.join(work, '..', 'make.log'), 'utf8'), '--no-print-directory -k good\n--no-print-directory -k bad\n--no-print-directory -k bad\n');
  assert.equal(record(work).result, 'passed');
  assert.match(readFileSync(path.join(work, REPORT, 'targets/bad.log'), 'utf8'), /\[report\] make bad exited with status 0\n$/);
});

test('the command prints its usage for arguments that do not fit', (t) => {
  const { work } = prepared(t);
  const refused = run(work, process.execPath, ['scripts/kit/full-run.mjs', 'run']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Usage: node scripts\/kit\/full-run\.mjs run/);
  const bad = run(work, process.execPath, ['scripts/kit/full-run.mjs', 'run', '../x']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /"\.\.\/x" is not a target name/);
});
