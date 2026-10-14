// The record of one run of the check runner (scripts/check/run.mts): the targets and the setup steps of the run with their
// status and times, written to .runtime/check/<run id>/record.json. The runner writes it before the first step and at the
// start and the end of each step, so a run that is killed stays recorded as `incomplete`. The report (scripts/check/report.mts)
// and the summary step of CI (scripts/check/summary.mts) read it. The guard of the full suite, the one run per tree and the
// push check are the tools of @polyspec/kit (make check, make rerun-failed, make hooks-check).
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { StepRecord } from './report.mts';
import { errorCode, errorMessage } from '../../tests/errors.mts';
import { readJsonFile } from '../json/schema.mts';

/** The record of one run: its steps, and the targets that failed or did not finish. */
export type CheckRecord = { id: string; tree: string; commit: string; started: string; ended: string | null; result: string; reason?: string; failed: string[]; incomplete: string[]; setup: StepRecord[]; targets: StepRecord[]; reportErrors?: string[]; report?: string; disk?: { [place: string]: number } };
/** The recorder of a run (startRecord). */
export type Recorder = {
  writeErrors: string[];
  begin: (name: string, kind: string) => StepRecord;
  end: (step: StepRecord, passed: boolean, details?: Partial<StepRecord>) => void;
  notRun: (name: string, reason: string) => void;
  crash: (reason: string) => CheckRecord;
  finish: () => CheckRecord;
};

const now = () => new Date().toISOString();

// A step is pending (not started), running, passed, failed, or not-run (a setup step it needs failed; reason names that step
// and its first failure line).
const newStep = (name: string): StepRecord => ({ name, status: 'pending', started: null, ended: null });

/** readRecord reads a record.json against its schema (schema/record.schema.json). */
export function readRecord(path: string): CheckRecord {
  return readJsonFile<CheckRecord>(path, new URL('./schema/record.schema.json', import.meta.url).pathname);
}

// recordPath is the file of the record of the run `id`.
export const recordPath = (root: string, id: string): string => resolve(root, '.runtime/check', id, 'record.json');

// summarize sets failed (the targets that failed) and incomplete (the targets that did not start or did not end) from the
// status of the targets. It runs before every write, so the two lists are right in the record of a killed run too.
export function summarize(record: CheckRecord): CheckRecord {
  record.failed = record.targets.filter(target => target.status === 'failed').map(target => target.name);
  record.incomplete = record.targets.filter(target => target.status !== 'passed' && target.status !== 'failed').map(target => target.name);
  return record;
}

// The record is replaced through a temporary file and a rename, so a reader never sees a half written record.
function write(path: string, record: CheckRecord): void {
  summarize(record);
  mkdirSync(dirname(path), { recursive: true });
  const written = `${path}.${process.pid}`;
  writeFileSync(written, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(written, path);
}

function git(root: string, ...args: string[]): string {
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
export function startRecord(root: string, id: string, targets: string[]): { record: CheckRecord; recorder: Recorder } {
  const path = recordPath(root, id);
  const record: CheckRecord = {
    id, tree: git(root, 'rev-parse', 'HEAD^{tree}'), commit: git(root, 'rev-parse', 'HEAD'), started: now(), ended: null,
    result: 'incomplete', failed: [], incomplete: [...targets], setup: [], targets: targets.map(newStep),
  };
  write(path, record);
  const writeErrors: string[] = [];
  const save = () => {
    try {
      write(path, record);
    } catch (error) {
      const message = `record write failed: ${path}: ${errorCode(error) ?? (error instanceof Error ? error.name : 'Error')}: ${errorMessage(error)}`;
      writeErrors.push(message);
      console.log(`check: ${message}`);
    }
  };
  const recorder: Recorder = {
    writeErrors,
    begin(name, kind) {
      let step: StepRecord | undefined;
      if (kind === 'setup') record.setup.push(step = newStep(name));
      else step = record.targets.find(target => target.name === name);
      if (!step) throw new Error(`the run has no target ${name}`);
      Object.assign(step, { status: 'running', started: now(), ended: null });
      save();
      return step;
    },
    end(step, passed, details = {}) {
      Object.assign(step, { status: passed ? 'passed' : 'failed', ended: now() }, details);
      save();
    },
    notRun(name, reason) {
      const target = record.targets.find(step => step.name === name);
      if (!target) throw new Error(`the run has no target ${name}`);
      Object.assign(target, { status: 'not-run', started: null, ended: now(), reason });
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
