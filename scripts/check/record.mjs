// The record of one run of the check runner (scripts/check/run.mjs): the targets and the setup steps of the run with their
// status and times, written to .runtime/check/<run id>/record.json. The runner writes it before the first step and at the
// start and the end of each step, so a run that is killed stays recorded as `incomplete`. The report (scripts/check/report.mjs)
// and the summary step of CI (scripts/check/summary.mjs) read it. The guard of the full suite, the one run per tree and the
// push check are the tools of scripts/kit (make check, make rerun-failed, make hooks-check).
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const now = () => new Date().toISOString();

// A step is pending (not started), running, passed, failed, or not-run (a setup step it needs failed; reason names that step
// and its first failure line).
const newStep = name => ({ name, status: 'pending', started: null, ended: null });

// recordPath is the file of the record of the run `id`.
export const recordPath = (root, id) => resolve(root, '.runtime/check', id, 'record.json');

// summarize sets failed (the targets that failed) and incomplete (the targets that did not start or did not end) from the
// status of the targets. It runs before every write, so the two lists are right in the record of a killed run too.
export function summarize(record) {
  record.failed = record.targets.filter(target => target.status === 'failed').map(target => target.name);
  record.incomplete = record.targets.filter(target => target.status !== 'passed' && target.status !== 'failed').map(target => target.name);
  return record;
}

// The record is replaced through a temporary file and a rename, so a reader never sees a half written record.
function write(path, record) {
  summarize(record);
  mkdirSync(dirname(path), { recursive: true });
  const written = `${path}.${process.pid}`;
  writeFileSync(written, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(written, path);
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited with ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// startRecord writes the first record of the run `id` of `targets` and returns { record, recorder }. recorder.begin(name, kind)
// records the start of a setup step (kind 'setup') or of a target, recorder.end(step, passed, details) its result (details:
// the log path, the elapsed time in ms and the first failure lines), recorder.notRun(name, reason) a target that did not run,
// recorder.crash(reason) a run that stopped on an error of the runner, and recorder.finish() the result of the run. A write
// that fails does not stop the run; recorder.writeErrors collects it for the summary and the exit status.
export function startRecord(root, id, targets) {
  const path = recordPath(root, id);
  const record = {
    id, tree: git(root, 'rev-parse', 'HEAD^{tree}'), commit: git(root, 'rev-parse', 'HEAD'), started: now(), ended: null,
    result: 'incomplete', failed: [], incomplete: [...targets], setup: [], targets: targets.map(newStep),
  };
  write(path, record);
  const writeErrors = [];
  const save = () => {
    try {
      write(path, record);
    } catch (error) {
      const message = `record write failed: ${path}: ${error.code ?? error.name}: ${error.message}`;
      writeErrors.push(message);
      console.log(`check: ${message}`);
    }
  };
  const recorder = {
    writeErrors,
    begin(name, kind) {
      let step;
      if (kind === 'setup') record.setup.push(step = newStep(name));
      else step = record.targets.find(target => target.name === name);
      Object.assign(step, { status: 'running', started: now(), ended: null });
      save();
      return step;
    },
    end(step, passed, details = {}) {
      Object.assign(step, { status: passed ? 'passed' : 'failed', ended: now() }, details);
      save();
    },
    notRun(name, reason) {
      Object.assign(record.targets.find(target => target.name === name), { status: 'not-run', started: null, ended: now(), reason });
      save();
    },
    crash(reason) {
      summarize(record);
      record.result = 'crashed';
      record.reason = reason;
      record.ended = now();
      save();
      return record;
    },
    finish() {
      summarize(record);
      // A run whose report or record could not be written is a failed run: its information is incomplete.
      const lostWrites = (record.reportErrors?.length ?? 0) + writeErrors.length + [...record.targets, ...record.setup].filter(step => step.reportErrors?.length).length;
      const failed = record.failed.length > 0 || record.incomplete.length > 0 || record.setup.some(step => step.status !== 'passed') || lostWrites > 0;
      record.result = failed ? 'failed' : 'passed';
      record.ended = now();
      save();
      console.log(`check: result ${record.result}; targets that failed: ${record.failed.join(', ') || 'none'}; targets that did not finish: ${record.incomplete.join(', ') || 'none'}; record ${path}`);
      return record;
    },
  };
  return { record, recorder };
}
