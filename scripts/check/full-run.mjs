// make check(전체 suite)와 make rerun-failed(그 suite에서 통과하지 못한 target의 재실행)의 guard와 실행
// 기록이다.
//
// guard는 어떤 단계보다 먼저 결정하고 그 결정을 이유와 함께 출력한다. docs/checklist.md의 항목(하위 항목
// 포함)이 `[~]`인 동안(각 ID와 제목을 적는다), 추적하는 file에 commit하지 않은 변경이 있는 동안, 기록이
// 적은 실행의 process가 아직 실행 중인 동안 두 진입점을 모두 거부한다. make check는 기록이 같은
// tree(`git rev-parse HEAD^{tree}`)의 전체 실행을 담고 있으면 거부한다: 전체 suite는 tree마다 한 번
// 실행한다. make rerun-failed는 기록이 현재 tree의 것이고 통과하지 못한 target을 담고 있을 때만 그
// target만 실행한다. GitHub CI의 checkout처럼 새 checkout에는 기록이 없다.
//
// 기록 .runtime/full-run.json(git이 무시한다)은 checkout의 마지막 전체 실행이다: tree, commit, 결과,
// 통과하지 못한 target, runner의 단계(실행의 database 만들기와 지우기)와 target마다 상태와 시각, 그리고
// 재실행들. runner(scripts/check/run.mjs)가 첫 단계 전과 각 단계의 시작과 끝마다 쓰므로, 강제 종료된
// 실행은 결과 `incomplete`로 남는다. 결정과 첫 기록은 .runtime/full-run.lock을 배타적으로 만든 동안
// 하므로, 동시에 시작한 두 실행이 둘 다 허용되지 않는다.
//
// make check의 첫 줄 `node scripts/check/full-run.mjs decide check`는 test server 환경을 읽고 lease
// program을 build하기 전에 같은 결정을 출력하고 거부한다. runner는 실행을 기록하기 직전에 다시
// 결정한다(claim): 그 사이에 다른 실행이 시작했을 수 있기 때문이다.
//
// Usage: node scripts/check/full-run.mjs decide check|rerun-failed
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRIES = { check: 'make check', 'rerun-failed': 'make rerun-failed' };
const ITEM = /^\s*- \[(.)\] (\S+)\s+(.*)$/gm;
const SENTENCE = /^(.+?\.)(?:\s|$)/;

// activeItems는 진행 중인 항목마다 ID와 제목(첫 문장)을 돌려준다.
export function activeItems(checklist) {
  return [...checklist.matchAll(ITEM)]
    .filter(([, state]) => state === '~')
    .map(([, , id, text]) => ({ id, title: SENTENCE.exec(text)?.[1] ?? text.trim() }));
}

function describe(record) {
  return `the full run of tree ${record.tree} started ${record.started}, ended ${record.ended ?? 'never (killed or still running)'}, result ${record.result}, targets that failed: ${record.failed.join(', ') || 'none'}, targets that did not finish: ${(record.incomplete ?? []).join(', ') || 'none'}`;
}

// unfinished는 통과하지 못한 target이다: 실패한 것과 끝나지 않은 것(실행 중이었거나 실행하지 않은 것).
// make rerun-failed는 이것만 다시 실행한다.
const unfinished = record => record.targets.filter(target => target.status !== 'passed').map(target => target.name);

// summarize는 기록의 failed(실패한 target)와 incomplete(시작하지 않았거나 끝나지 않은 target)를 target의
// 상태에서 다시 정한다. 기록을 쓸 때마다 부르므로 강제 종료된 실행의 기록에서도 두 목록이 맞다.
export function summarize(record) {
  record.failed = record.targets.filter(target => target.status === 'failed').map(target => target.name);
  record.incomplete = record.targets.filter(target => target.status !== 'passed' && target.status !== 'failed').map(target => target.name);
  return record;
}

// decide는 mode를 실행할 수 있는지 정한다. targets는 전체 실행의 target이고, running은 기록이 적은 실행
// process가 아직 실행 중인지다.
export function decide(mode, { items, changes, tree, record, targets, running = false }) {
  const reasons = [];
  if (items.length) {
    reasons.push('checklist items are in progress (docs/checklist.md):');
    for (const { id, title } of items) reasons.push(`  ${id} ${title}`);
  }
  if (changes.length) {
    reasons.push('uncommitted changes of tracked files:');
    for (const change of changes) reasons.push(`  ${change}`);
  }
  if (record?.runner && running)
    reasons.push(`pid ${record.runner.pid} runs ${record.runner.entry} since ${record.runner.started}; it removes its runner entry from .runtime/full-run.json when it ends`);
  let selected = [];
  if (mode === 'check') {
    if (record && record.tree === tree)
      reasons.push(`${describe(record)}; the full suite runs once per tree${record.failed.length ? '; rerun the targets that did not pass with make rerun-failed' : ''}`);
    selected = targets;
  } else if (!record) {
    reasons.push('no full run is recorded (.runtime/full-run.json); run make check');
  } else if (record.tree !== tree) {
    reasons.push(`the recorded full run is of tree ${record.tree}, not of the current tree ${tree}; rerun-failed reruns targets of the current tree only`);
  } else {
    selected = unfinished(record);
    if (!selected.length) reasons.push(`${describe(record)}; every target passed, nothing to rerun`);
  }
  return { allowed: reasons.length === 0, reasons, targets: selected };
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited with ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

const recordPath = root => resolve(root, '.runtime/full-run.json');

function read(path) {
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, 'utf8'));
  for (const field of ['tree', 'started', 'result', 'failed', 'targets', 'reruns'])
    if (!(field in record)) throw new Error(`${path} has no ${field}; it is not a full run record`);
  return record;
}

// 기록은 임시 file을 rename해 한 번에 바꾸므로 읽는 쪽은 쓰다 만 기록을 보지 않는다. 쓰기 전에 failed와
// incomplete를 target의 상태에서 다시 정한다.
function write(path, record) {
  summarize(record);
  mkdirSync(resolve(path, '..'), { recursive: true });
  const written = `${path}.${process.pid}`;
  writeFileSync(written, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(written, path);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

// state는 checkout의 결정 입력을 읽는다.
function state(root) {
  const record = read(recordPath(root));
  return {
    tree: git(root, 'rev-parse', 'HEAD^{tree}').trim(),
    changes: git(root, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean),
    items: activeItems(readFileSync(resolve(root, 'docs/checklist.md'), 'utf8')),
    record,
    running: Boolean(record?.runner && alive(record.runner.pid)),
  };
}

export function printRefusal(entry, reasons) {
  console.log(`full-run: refused ${entry}:`);
  for (const reason of reasons) console.log(`full-run: ${reason}`);
}

const now = () => new Date().toISOString();
const newStep = name => ({ name, status: 'not run', started: null, ended: null });

// claim은 .runtime/full-run.lock을 배타적으로 만든 동안 결정하고, 허용되면 첫 기록을 쓴다. 그 file이
// 남아 있으면 그것을 만든 process가 결정 도중에 끝난 것이므로 거부하고 그 file을 적는다. 허용된 실행은
// { targets, recorder }를 받는다. recorder.begin(name, kind)은 단계(kind 'setup')나 target의 시작을,
// recorder.end(step, passed)는 결과를 기록하고, recorder.finish()는 실행의 결과를 기록해 돌려준다.
export function claim(root, mode, targets) {
  const entry = ENTRIES[mode];
  const lock = resolve(root, '.runtime/full-run.lock');
  mkdirSync(resolve(root, '.runtime'), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { refused: [`${lock} exists: pid ${readFileSync(lock, 'utf8').trim()} is deciding a run, or ended while deciding; remove the file when that pid is not running`] };
  }
  let claimed;
  try {
    writeFileSync(descriptor, `${process.pid}\n`);
    claimed = start(root, mode, entry, targets);
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
  return claimed;
}

function start(root, mode, entry, targets) {
  const path = recordPath(root);
  const current = state(root);
  const decision = decide(mode, { ...current, targets });
  if (!decision.allowed) return { refused: decision.reasons };
  const started = now();
  const runner = { pid: process.pid, entry, started };
  let record;
  let run;
  if (mode === 'check') {
    console.log(`full-run: allowed ${entry}: no checklist item is in progress, the tracked files are committed and no full run of tree ${current.tree} is recorded; running ${targets.length} targets: ${targets.join(' ')}`);
    record = {
      entry, tree: current.tree, commit: git(root, 'rev-parse', 'HEAD').trim(), started, ended: null, result: 'incomplete',
      failed: [], incomplete: [...targets], runner, setup: [], targets: targets.map(newStep), reruns: [],
    };
    run = record;
  } else {
    console.log(`full-run: allowed ${entry}: the full run of tree ${current.tree} recorded ${decision.targets.length} targets that did not pass; rerunning only: ${decision.targets.join(' ')}`);
    record = { ...current.record, ended: null, result: 'incomplete', runner };
    run = { started, ended: null, result: 'incomplete', targets: decision.targets, setup: [] };
    record.reruns.push(run);
  }
  write(path, record);
  const recorder = {
    begin(name, kind) {
      let step;
      if (kind === 'setup') run.setup.push(step = newStep(name));
      else step = record.targets.find(target => target.name === name);
      Object.assign(step, { status: 'running', started: now(), ended: null });
      write(path, record);
      return step;
    },
    end(step, passed) {
      Object.assign(step, { status: passed ? 'passed' : 'failed', ended: now() });
      write(path, record);
    },
    finish() {
      summarize(record);
      const failed = record.failed.length > 0 || record.incomplete.length > 0 || run.setup.some(step => step.status !== 'passed');
      record.result = run.result = failed ? 'failed' : 'passed';
      record.ended = run.ended = now();
      record.runner = null;
      write(path, record);
      console.log(`full-run: ${entry} result ${record.result}; targets that failed: ${record.failed.join(', ') || 'none'}; targets that did not finish: ${record.incomplete.join(', ') || 'none'}; record ${path}`);
      if (unfinished(record).length) console.log('full-run: run make rerun-failed to rerun only those targets');
      return record;
    },
  };
  return { targets: decision.targets, recorder };
}

// preflight는 make check와 make rerun-failed의 첫 줄이다: 결정을 출력하고 거부면 2, 아니면 0을 돌려준다.
// 기록은 쓰지 않는다.
export function preflight(root, mode) {
  const decision = decide(mode, { ...state(root), targets: [] });
  if (!decision.allowed) {
    printRefusal(ENTRIES[mode], decision.reasons);
    return 2;
  }
  console.log(`full-run: ${ENTRIES[mode]} may start; the runner decides again when it records the run`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, mode] = process.argv.slice(2);
  if (process.argv.length !== 4 || action !== 'decide' || !(mode in ENTRIES)) {
    console.error('usage: node scripts/check/full-run.mjs decide check|rerun-failed');
    process.exit(2);
  }
  process.exitCode = preflight(resolve(fileURLToPath(new URL('../..', import.meta.url))), mode);
}
