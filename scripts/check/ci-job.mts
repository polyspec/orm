// The runner of the recipe of one CI job (make ci-<job>, T497). A workflow job runs one step, `make ci-<job>`, and the
// recipe holds the order and the conditions of the job, so a local `make ci-<job> NAME=value` runs what CI runs. Each line
// of the recipe is one call of this script, which records the result in the state of the job and ends with 0, so that make
// runs the next line; the last line (end) ends with the status of the job:
//   begin <job> [--group <group> <target>...]  starts the state of the job; with --group it holds the outputs of the needs of
//                                             the targets of that CI group (groupOutputs of scripts/check/ci-setup.mts)
//   setup <job> <id> [--when <output>] -- <make arguments>
//                                             runs make with the arguments, unless an earlier setup step failed or the output
//                                             --when of the group is false: then it records the step as skipped. Setup stops at
//                                             the first failure, and every later setup step is recorded as skipped
//   check <job> -- <make arguments>           runs make with the arguments whatever the setup steps did; every check runs to
//                                             its end, and the check runner (scripts/check/run.mts) reads the results of the
//                                             setup steps from ORM_CI_SETUP_FILE and records a target that needs what a failed
//                                             or skipped step installs as not-run
//   always <job> [--after <id>] -- <make arguments>
//                                             runs make with the arguments in every case (summary, cleanup); with --after, only
//                                             when the setup step <id> ran, so a cleanup runs only after its preparation
//   end <job>                                 prints every step and ends with 1 when a setup step failed, a check failed or an
//                                             always step failed, else with 0
// Every make call gets ORM_CHECK_RUN_ID=<job>, ORM_CI_SETUP_FILE, the file of the setup results, and CI_GROUP_<OUTPUT>=true|false
// for each output of the group. The state is .runtime/ci/<run name of the job>/ (runName of scripts/check/report.mts), which
// belongs to the run of that job.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupOutputs } from './ci-setup.mts';
import { declaredNeeds } from './inputs.mts';
import { runName } from './report.mts';

/** The outcome of a step, as GitHub names the outcome of a step. */
export type Outcome = 'success' | 'failure' | 'skipped';
/** The state of one job: the outputs of its group, its setup steps in order, and its other steps. */
export type JobState = {
  job: string;
  outputs: Record<string, boolean>;
  steps: Record<string, { outcome: Outcome; reason?: string }>;
  setupFailed: string | null;
  others: { kind: 'check' | 'always'; command: string; outcome: Outcome }[];
};

/** startState is the state of a job that has run no step. */
export function startState(job: string, outputs: Record<string, boolean> = {}): JobState {
  return { job, outputs, steps: {}, setupFailed: null, others: [] };
}

/**
 * setupDecision is whether the setup step `id` runs: null when it runs, else the reason it is skipped. A step is skipped after
 * a failed setup step, and when the output `when` of the group is false.
 */
export function setupDecision(state: JobState, id: string, when: string | undefined): string | null {
  if (Object.hasOwn(state.steps, id)) throw new Error(`the job ${state.job} runs the setup step ${id} twice; give each setup step of the recipe its own id`);
  if (state.setupFailed !== null) return `the setup step ${state.setupFailed} failed before it`;
  if (when !== undefined) {
    if (!Object.hasOwn(state.outputs, when)) throw new Error(`the setup step ${id} runs --when ${when}, which is no output of the group of the job ${state.job}; name an output of GROUP_OUTPUTS of scripts/check/ci-setup.mts`);
    if (!state.outputs[when]) return `no target of the group needs ${when}`;
  }
  return null;
}

/** recordSetup records the outcome of the setup step `id`; a failure skips every later setup step. */
export function recordSetup(state: JobState, id: string, outcome: Outcome, reason?: string): JobState {
  const steps = { ...state.steps, [id]: reason === undefined ? { outcome } : { outcome, reason } };
  return { ...state, steps, setupFailed: state.setupFailed ?? (outcome === 'failure' ? id : null) };
}

/** ranSetup is whether the setup step `id` ran, whatever its outcome. */
export function ranSetup(state: JobState, id: string): boolean {
  const step = state.steps[id];
  return step !== undefined && step.outcome !== 'skipped';
}

/** jobStatus is the exit status of the job: 1 when a setup step, a check or an always step failed, else 0. */
export function jobStatus(state: JobState): number {
  return state.setupFailed !== null || state.others.some(step => step.outcome === 'failure') ? 1 : 0;
}

/** jobLines are the lines that end prints: every step with its outcome. */
export function jobLines(state: JobState): string[] {
  return [
    ...Object.entries(state.steps).map(([id, step]) => `ci-job ${state.job}: setup ${id}: ${step.outcome}${step.reason ? ` (${step.reason})` : ''}`),
    ...state.others.map(step => `ci-job ${state.job}: ${step.kind} make ${step.command}: ${step.outcome}`),
    `ci-job ${state.job}: ${jobStatus(state) === 0 ? 'passed' : state.setupFailed !== null ? `failed: the setup step ${state.setupFailed} failed` : 'failed: a check failed'}`,
  ];
}

/** jobEnvironment is the environment that every make call of the job gets. */
export function jobEnvironment(state: JobState, stepsFile: string): Record<string, string> {
  return {
    ORM_CHECK_RUN_ID: state.job,
    ORM_CI_SETUP_FILE: stepsFile,
    ...Object.fromEntries(Object.entries(state.outputs).map(([output, value]) => [`CI_GROUP_${output.toUpperCase().replaceAll('-', '_')}`, String(value)])),
  };
}

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const directory = (job: string) => join(root, '.runtime/ci', runName(job));
const stateFile = (job: string) => join(directory(job), 'job.json');
const stepsFile = (job: string) => join(directory(job), 'steps.json');

// write publishes a file with one rename, so a reader sees the old or the new content whole.
function write(path: string, text: string): void {
  const next = `${path}.${process.pid}`;
  writeFileSync(next, text);
  renameSync(next, path);
}

function save(state: JobState): void {
  mkdirSync(directory(state.job), { recursive: true });
  write(stateFile(state.job), `${JSON.stringify(state, null, 2)}\n`);
  write(stepsFile(state.job), `${JSON.stringify(state.steps)}\n`);
}

const OUTCOMES: readonly string[] = ['success', 'failure', 'skipped'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isOutcome = (value: unknown): value is Outcome => typeof value === 'string' && OUTCOMES.includes(value);

// jobState is the state that a file holds, checked as it is read: a state that begin did not write throws naming the file.
function jobState(value: unknown, file: string): JobState {
  const bad = (what: string): never => { throw new Error(`${file}: ${what}`); };
  if (!isRecord(value)) return bad('a job state is an object');
  const { job, outputs, steps, setupFailed, others } = value;
  if (typeof job !== 'string') return bad('job is a string');
  if (!isRecord(outputs) || !Object.values(outputs).every(output => typeof output === 'boolean')) return bad('outputs map names to booleans');
  if (!isRecord(steps)) return bad('steps is an object');
  const checkedSteps: JobState['steps'] = {};
  for (const [id, step] of Object.entries(steps)) {
    if (!isRecord(step) || !isOutcome(step['outcome']) || (step['reason'] !== undefined && typeof step['reason'] !== 'string')) return bad(`step ${id} has an outcome and may have a reason`);
    checkedSteps[id] = step['reason'] === undefined ? { outcome: step['outcome'] } : { outcome: step['outcome'], reason: step['reason'] };
  }
  if (setupFailed !== null && typeof setupFailed !== 'string') return bad('setupFailed is a string or null');
  if (!Array.isArray(others)) return bad('others is a list');
  const checkedOthers = others.map((other: unknown, at): JobState['others'][number] => {
    if (!isRecord(other) || (other['kind'] !== 'check' && other['kind'] !== 'always') || typeof other['command'] !== 'string' || !isOutcome(other['outcome'])) return bad(`others/${at} has a kind, a command and an outcome`);
    return { kind: other['kind'], command: other['command'], outcome: other['outcome'] };
  });
  return { job, outputs: Object.fromEntries(Object.entries(outputs).map(([name, on]) => [name, on === true])), steps: checkedSteps, setupFailed, others: checkedOthers };
}

function load(job: string): JobState {
  try {
    return jobState(JSON.parse(readFileSync(stateFile(job), 'utf8')), stateFile(job));
  } catch (error) {
    throw new Error(`the job ${job} has no state at ${stateFile(job)}: ${error instanceof Error ? error.message : String(error)}; its recipe starts with ci-job.mts begin ${job}`, { cause: error });
  }
}

// make runs make with the arguments in the environment of the job and returns whether it succeeded. On GitHub Actions the
// output of each call is a group of the log.
function make(state: JobState, label: string, args: string[]): boolean {
  const actions = process.env.GITHUB_ACTIONS === 'true';
  console.log(actions ? `::group::${label}: make ${args.join(' ')}` : `ci-job ${state.job}: ${label}: make ${args.join(' ')}`);
  const result = spawnSync(process.env.CI_JOB_MAKE || 'make', ['--no-print-directory', ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...jobEnvironment(state, stepsFile(state.job)) } });
  if (actions) console.log('::endgroup::');
  if (result.error) console.error(`ci-job ${state.job}: make could not start: ${result.error.message}`);
  if (result.signal) console.error(`ci-job ${state.job}: make ${args.join(' ')} ended by signal ${result.signal}`);
  const passed = result.status === 0;
  if (!passed) console.log(actions ? `::error title=${label}::make ${args.join(' ')} failed` : `ci-job ${state.job}: ${label}: make ${args.join(' ')} failed`);
  return passed;
}

// split reads `<before...> -- <make arguments...>`.
function split(args: string[]): { before: string[]; command: string[] } {
  const at = args.indexOf('--');
  if (at === -1 || at === args.length - 1) throw new Error('give the make arguments after --');
  return { before: args.slice(0, at), command: args.slice(at + 1) };
}

function main(args: string[]): number {
  const [action = '', job = '', ...rest] = args;
  if (!job) throw new Error('usage: node scripts/check/ci-job.mts begin|setup|check|always|end <job> ...');
  if (action === 'begin') {
    let outputs: Record<string, boolean> = {};
    if (rest[0] === '--group') {
      const [, group, ...targets] = rest;
      if (!group || targets.length === 0) throw new Error(`begin ${job} --group needs the group and its targets`);
      outputs = groupOutputs(targets, declaredNeeds(root));
    } else if (rest.length) throw new Error(`begin ${job} takes only --group <group> <target>...`);
    save(startState(job, outputs));
    return 0;
  }
  const state = load(job);
  if (action === 'setup') {
    const { before, command } = split(rest);
    const [id, flag, when] = before;
    if (!id || (flag !== undefined && (flag !== '--when' || !when)) || before.length > 3) throw new Error(`setup ${job} takes <id> [--when <output>] -- <make arguments>`);
    const skipped = setupDecision(state, id, when);
    if (skipped !== null) {
      console.log(`ci-job ${job}: setup ${id} skipped: ${skipped}`);
      save(recordSetup(state, id, 'skipped', skipped));
      return 0;
    }
    save(recordSetup(state, id, make(state, `setup ${id}`, command) ? 'success' : 'failure'));
    return 0;
  }
  if (action === 'check' || action === 'always') {
    const { before, command } = split(rest);
    const after = action === 'always' && before[0] === '--after' && before.length === 2 ? before[1] : undefined;
    if (before.length && after === undefined) throw new Error(`${action} ${job} takes ${action === 'always' ? '[--after <id>] ' : ''}-- <make arguments>`);
    if (after !== undefined && !ranSetup(state, after)) {
      console.log(`ci-job ${job}: always make ${command.join(' ')} skipped: the setup step ${after} did not run`);
      save({ ...state, others: [...state.others, { kind: action, command: command.join(' '), outcome: 'skipped' }] });
      return 0;
    }
    const outcome: Outcome = make(state, action, command) ? 'success' : 'failure';
    save({ ...state, others: [...state.others, { kind: action, command: command.join(' '), outcome }] });
    return 0;
  }
  if (action === 'end') {
    for (const line of jobLines(state)) console.log(line);
    return jobStatus(state);
  }
  throw new Error(`unknown action ${action}; use begin, setup, check, always or end`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ci-job: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
