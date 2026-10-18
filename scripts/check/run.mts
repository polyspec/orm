// The runner for make check-run, make bench, and make run-databases. Each run has its own bench
// database and decimal database (scripts/check/databases.mts), so that every target uses them,
// runs each target one at a time with `make <target>`, then removes the databases. So that another run or
// session does not rely on state it left behind in a shared database.
//
// a target is a bundle of cases each with its own deadline, so with runGroup it reports "RUN check/<target> group",
// that target's output lines (STEP), PASS or FAIL, and the elapsed time. Before each target, the remaining disk
// space is printed as a step. The run does not stop at a failure: even if a target fails, it runs the other targets,
// and each target runs with `make -k`, so independent sub-targets in a recipe also run after an earlier failure. The setup steps are servers (test
// reads the server environment file and holds that server's shared lease) and databases/create. A target that needs a failed setup step
// (`needs` in contracts/check-inputs.json) is not run and is recorded as `not-run`, with the failed step and its first failure line
// as the reason; targets that do not need it still run. Each run writes a report (scripts/check/report.mts): for each target,
// the exact command, recipe, inputs and outputs, the run directory of a failed target, the environment, and at the end, the summary. If the run fails or
// has a target that did not run, it exits with 1. The run id is ORM_CHECK_RUN_ID (CI supplies the run id and attempt), or
// a name newly made for each run; the report is in .runtime/check/<id>/report.
//
// The run records the creation and removal of databases and the start and result of each target in .runtime/check/<id>/record.json
// (scripts/check/record.mts). The full suite's guard (in-progress items, uncommitted changes, once per tree)
// is handled by the @polyspec/kit guard (`make check`) before this runner.
//
// Usage: [ORM_CHECK_RUN_ID=<id>] node scripts/check/run.mts [--job-summary] <servers env | -> <target>...
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { duration, runGroup } from '../../tests/testcase.mts';
import { expandNeeds, failedCiSetup, SETUP_NEEDS } from './ci-setup.mts';
import { startRecord } from './record.mts';
import { runStep } from './step.mts';
import { monitor } from './resources.mts';
import { missingDownloads } from './downloads.mts';
import { errorMessage } from '../../tests/errors.mts';
import type { Step } from '../../tests/testcase.mts';
import type { DiskSnapshot, StepRecord } from './report.mts';
import type { Recorder, CheckRecord as RunRecord } from './record.mts';
import type { ReportWriter } from './report.mts';
import { declaredNeeds, readCheckInputs } from './inputs.mts';

/** The options of a step's command: its failure label, the directory its temporary entries are kept in, its leftovers and whether it is guarded. */
export type CommandOptions = { label?: string; keep?: string; leftovers?: () => string[]; guard?: boolean };
/** A command runner of the check (command(root)). */
export type Run = (program: string, args: string[], step: Step, spawned?: (pid: number | undefined) => void, options?: CommandOptions) => Promise<void>;
/** The body of one recorded step. */
type StepBody = (context: { step: Step; spawned: (pid: number | undefined) => void; options: CommandOptions }) => Promise<unknown>;
/** The result of one step of the run. */
type Result = Partial<StepRecord> & { label: string; passed: boolean; elapsed: number; notRun?: string };

import { cappedLog, diskSnapshot, failures, keepFile, keepRunDirectory, npmErrors, NPM_LOG, publish, spaceCause, reportDirectory, reportWriter, runName, summary, writeEnvironment } from './report.mts';

// command runs a program as one step (runStep: its own temporary directory and process group) and emits its output lines as the step.
// MAKEFLAGS of make is not passed on: the sub-make receives only the TEST_ENV and DECIMAL_ENV this runner gives it. spawned takes the
// process id that was started. label in options is the name on failure lines; keep is the directory into which a failed step's temporary entries are copied,
// leftovers is the function that finds what remains outside the step, and guard: false marks a setup step.
export const command = (root: string): Run => (program, args, step, spawned = () => {}, { label, keep, leftovers, guard } = {}) => {
  const env = { ...process.env };
  for (const variable of ['MAKEFLAGS', 'MFLAGS', 'MAKELEVEL', 'MAKEOVERRIDES']) delete env[variable];
  return runStep(program, args, { cwd: root, env, step, spawned, ...(label === undefined ? {} : { label }), ...(leftovers === undefined ? {} : { leftovers }), ...(guard === undefined ? {} : { guard }), ...(keep === undefined ? {} : { keep: (source: string) => { keepRunDirectory(source, keep); } }) });
};

// serverEnvironment reads the environment file make test-servers wrote (`export NAME='value'` lines). If the file is missing, the server
// was not started, so it throws with that path.
export function serverEnvironment(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`${path} is missing: make test-servers did not write the server environment`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^export ([A-Z0-9_]+)='([^']*)'$/.exec(line);
    if (match) env[match[1] ?? ''] = match[2] ?? '';
    else if (line.trim() && !line.startsWith('#')) throw new Error(`${path}: an unreadable line: ${line}`);
  }
  return env;
}

export { declaredNeeds };

// recipeText is the target's definition line and command lines in the Makefile. The target log in the report records them with the exact command.
function recipeText(root: string, target: string): string {
  const path = resolve(root, 'Makefile');
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').split('\n');
  const at = lines.findIndex(line => line.startsWith(`${target}:`) && !line.startsWith(`${target}:=`));
  if (at < 0) return '';
  const body = [lines[at] ?? ''];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('\t')) break;
    body.push(line);
  }
  return body.join('\n');
}

function targetInputs(root: string, target: string): string[] {
  const path = resolve(root, 'contracts/check-inputs.json');
  if (!existsSync(path)) return [];
  const targets = readCheckInputs(root).targets;
  return Object.hasOwn(targets, target) ? targets[target]?.inputs ?? [] : [];
}

// runChecks performs one run and returns the exit status: 1 for failure, 0 for pass. run
// is a function with the same shape as command (root). needs is the setup step each target needs ('databases'), id is the name of the run,
// snapshot is the space record (same shape as diskSnapshot).
/** The inputs of one run of the check. */
export type RunOptions = { root: string; jobSummary?: boolean; servers: string | null; targets: string[]; run: Run; needs?: Record<string, string[]>; id?: string | undefined; snapshot?: (root: string, run: string) => DiskSnapshot; ciSetup?: string | undefined; downloads?: typeof missingDownloads };

export async function runChecks({ root, jobSummary = false, servers: given, targets: declared, run, needs = declaredNeeds(root), id = process.env.ORM_CHECK_RUN_ID, snapshot = diskSnapshot, ciSetup = process.env.ORM_CI_SETUP, downloads = missingDownloads }: RunOptions): Promise<number> {
  let servers = given;
  // The run's name is the given id, or the process id plus a random value. If a database with the same name exists, it was not made by this run
  // so the names must not collide, to keep bench-db.mts from deleting it.
  const runId = id ? runName(id) : `orm_check_${process.pid}_${randomBytes(4).toString('hex')}`;
  const name = runId;
  const targets = declared;
  const { recorder, record: current } = startRecord(root, runId, targets);
  // The directory holds this run's database files (env, decimal-env, SQLite), and databases.mts drop deletes it whole. The report
  // is beside it: the drop does not delete the report.
  const directory = resolve(root, '.runtime/check', runId, 'databases');
  const report = reportDirectory(root, runId);
  // writer handles every write to the report and collects failures instead of throwing them (reportWriter).
  const writer = reportWriter();
  writer.run(join(report, 'targets'), () => mkdirSync(join(report, 'targets'), { recursive: true }));
  if (current) current.report = relative(root, report);
  writer.run(join(report, 'environment.txt'), () => writeEnvironment(root, report, { 'run id': runId, servers: servers ?? 'none' }));
  active = { recorder, writer, report, root, current };
  // disk is the run's space record (diskSnapshot): written at the start and after each step to report/disk/<n>-<step>.txt. For a failed
  // step, the record after the step is the space at the moment of failure.
  let snapshots = 0;
  const disk = (label: string) => {
    const taken = snapshot(root, resolve(root, '.runtime/check', runId));
    const file = join(report, 'disk', `${String(snapshots++).padStart(2, '0')}-${label.replaceAll('/', '-')}.txt`);
    writer.run(file, () => { mkdirSync(join(report, 'disk'), { recursive: true }); });
    writer.write(file, taken.text);
    return taken;
  };
  const started = disk('start');
  if (current) current.disk = started.places;
  const testEnv = resolve(directory, 'env');
  const decimalEnv = resolve(directory, 'decimal-env');

  const results: Result[] = [];
  // record runs one step. It writes the output to the target log and collects the failure lines.
  const record = async (label: string, kind: string, body: StepBody): Promise<boolean> => {
    const step = recorder.begin(label, kind);
    const started = performance.now();
    const log = join(report, 'targets', `${label.replaceAll('/', '-')}.log`);
    const found = failures();
    // is the path of the debug log npm wrote. A failed step moves that log into the report and takes its error line as the first failure line.
    const npmLogs = new Set<string>();
    let pid: number | undefined;
    const keepTemporary = join(report, 'targets', label.replaceAll('/', '-'), 'tmp');
    // runDirectories are the run directories (.runtime/run/<target>-<make pid>) left by this step's make.
    const runDirectories = () => {
      const runs = resolve(root, '.runtime/run');
      return pid && existsSync(runs) ? readdirSync(runs).filter(entry => entry.endsWith(`-${pid}`)).map(entry => join(runs, entry)) : [];
    };
    const header = kind === 'target'
      ? [`target ${label}`, `command: make --no-print-directory -k TEST_ENV=${testEnv} DECIMAL_ENV=${decimalEnv} ${label}`, 'recipe (Makefile):', recipeText(root, label), `inputs: ${targetInputs(root, label).join(' ')}`, '']
      : [`setup step ${label}`, ''];
    const written = writer.failed.length;
    const output = cappedLog(writer, log, `${header.join('\n')}\n`);
    const passed = await runGroup(`check/${label}`, ({ step: report }) => body({
      step: (text: string) => {
        output.line(text);
        found.line(text);
        const npm = NPM_LOG.exec(text);
        if (npm?.[1]) npmLogs.add(npm[1]);
        report(text);
      },
      spawned: (child: number | undefined) => { pid = child; },
      // A failed step's temporary entries are copied to targets/<step>/tmp in the report. If a passing step left a run directory, that
      // step fails.
      options: { label, keep: keepTemporary, leftovers: () => runDirectories().map(path => relative(root, path)) },
    }).catch((error: unknown) => { output.line(errorMessage(error)); found.exit(errorMessage(error)); throw error; }));
    const elapsed = performance.now() - started;
    const truncated = output.close() || null;
    const after = disk(label);
    writer.append(log, `free space after the step (KiB): ${JSON.stringify(after.places)}\n`);
    const lines = passed ? [] : found.lines();
    // npm errors are in the debug log outside the report. That log is moved into targets/<step>/, and its error line is placed before the first failure line.
    if (!passed)
      for (const path of npmLogs) {
        if (!existsSync(path)) {
          lines.unshift(`npm debug log ${path} is missing`);
          continue;
        }
        const kept = join(report, 'targets', label.replaceAll('/', '-'), basename(path));
        writer.run(kept, () => keepFile(path, kept));
        let errors: string[] = [];
        writer.run(kept, () => { errors = npmErrors(readFileSync(path, 'utf8')); });
        lines.unshift(...errors.map(error => `npm debug log ${relative(root, kept)}: ${error}`));
      }
    // A step that failed for lack of space records that fact and the space at that moment as its first failure line (spaceCause).
    const space = passed ? null : spaceCause(lines, after);
    if (space) lines.unshift(space);
    // Warnings (`WARNING`) are not failures. They are kept in the step's record and summary, and on GitHub Actions they are also written as `::warning::` annotations.
    const warnings = found.warnings();
    if (process.env.GITHUB_ACTIONS === 'true') for (const warning of warnings) console.log(`::warning title=${label}::${warning}`);
    const details: Partial<StepRecord> & { elapsed: number } = { log: relative(root, log), elapsed: Math.round(elapsed), disk: after.places, ...(passed ? {} : { failures: lines }), ...(warnings.length ? { warnings } : {}), ...(truncated ? { truncated } : {}) };
    // After copying the run directory (.runtime/run/<target>-<make pid>) left by a failed target into the report, it is deleted. The report
    // keeps the evidence, and nothing is left on disk.
    for (const path of runDirectories()) {
      if (!passed) {
        const kept = join(report, 'targets', label.replaceAll('/', '-'), 'run', basename(path));
        writer.run(kept, () => keepRunDirectory(path, kept));
      }
      rmSync(path, { recursive: true, force: true });
    }
    // A report write that failed during this step is recorded in that step's record.
    const reportErrors = writer.failed.slice(written);
    if (reportErrors.length) details.reportErrors = reportErrors;
    recorder.end(step, passed, details);
    results.push({ ...details, label, passed, elapsed });
    return passed;
  };
  const skip = (target: string, reason: string) => {
    recorder.notRun(target, reason);
    results.push({ label: target, passed: false, notRun: reason, elapsed: 0 });
    console.log(`NOT-RUN check/${target}: ${reason}`);
  };

  const failedSetup: Record<string, string> = {};
  // needsOf is the needs a target declares plus the needs its setup phase requires (SETUP_NEEDS in scripts/check/ci-setup.mts).
  // wanted is the need of this run's targets.
  const needsOf = (target: string) => expandNeeds(needs[target] ?? []);
  const wanted = new Set(targets.flatMap(needsOf));
  // CI setup step (scripts/check/ci-setup.mts): for each failed step in the step results the workflow gave as ORM_CI_SETUP, a setup phase
  // ci/<id> is recorded as failed, and targets declaring a need that step prepares are recorded as not-run. The step's output is in the job
  // log for that step. A CI group's job skips setup steps its group's targets do not need (make
  // ci-group-needs): a skipped step counts as a failure only when a target declaring its need is in this run.
  for (const { id: step, need, outcome } of failedCiSetup(ciSetup)) {
    if (outcome === 'skipped' && !wanted.has(need)) {
      console.log(`check: the CI setup step ${step} was skipped; no target of this run needs ${need}`);
      continue;
    }
    const reason = outcome === 'skipped'
      ? `the CI setup step ${step} was skipped, and a target of this run needs ${need}; make ci-group-needs runs the setup steps of the needs that contracts/check-inputs.json declares for the targets of the group`
      : `the CI setup step ${step} failed; its output is in the job log of that step`;
    if (!results.some(result => result.label === `ci/${step}`))
      await record(`ci/${step}`, 'setup', async ({ step: line }) => {
        line(reason);
        throw new Error(reason);
      });
    failedSetup[need] ??= reason;
  }
  // downloads: checks, without the network, that the downloads check reads are present (scripts/check/downloads.mts). For a missing download, the need
  // is declared by targets recorded as not-run with that reason (`run make install`), and the other targets run.
  // Only the downloads for the needs declared by the targets being run are checked: a run that only builds docs does not need the Rust crates.
  let missing: ReturnType<typeof downloads> = [];
  await record('downloads', 'setup', async ({ step }) => {
    missing = downloads(root).filter(({ need }) => wanted.has(need));
    for (const { message } of missing) step(`downloads: ${message}`);
    if (missing.length) throw new Error(`${missing.length} download(s) of the checks are missing; run make install, which downloads them`);
    step('downloads: every download of the checks is present');
  });
  for (const { need, message } of missing) failedSetup[need] ??= message;
  // servers: reads the test server environment, passes it to the sub-make, and holds the server's shared lease until this process ends. A run
  // without servers (the docs job in ci.yml, `-`) has no server or database steps, and records targets that need a database as not-run.
  // A run in which no target needs a database (a CI group without databases) does not read the servers and does not create a database.
  if (servers && !wanted.has('databases')) {
    console.log(`check: no target of this run needs databases; the run reads no servers and creates no databases`);
    servers = null;
  }
  if (!servers) failedSetup['databases'] = 'this run has no database servers';
  // If the needs that databases' setup phase requires (SETUP_NEEDS) are not prepared, it neither reads the servers nor creates databases, and for that reason
  // records databases as failed.
  const unmet = servers && (SETUP_NEEDS.databases ?? []).find(need => failedSetup[need]);
  if (unmet) {
    failedSetup['databases'] = `the setup steps servers and databases/create need ${unmet}: ${failedSetup[unmet] ?? ''}`;
    servers = null;
  }
  const serverFile = servers;
  const serversReady = serverFile !== null && await record('servers', 'setup', async ({ step }) => {
    const env = serverEnvironment(serverFile);
    Object.assign(process.env, env);
    step(`read ${Object.keys(env).length} variables from ${serverFile}`);
    const lease = process.env.LEASE;
    const leases = env['ORM_TEST_SERVERS_LEASES'];
    if (lease && leases) {
      const held = spawnSync(lease, ['hold', leases, 'shared', '--pid', String(process.pid)], { encoding: 'utf8' });
      if (held.status !== 0) throw new Error(`${lease} hold ${leases} shared exited with ${held.status}: ${(held.stderr || held.stdout).trim()}`);
      step(`holding the shared lease of ${leases}`);
    }
  });
  if (servers && !serversReady) failedSetup['databases'] = `the setup step servers failed: ${(results.at(-1)?.failures ?? []).join(' / ')}`;
  let created = false;
  if (serversReady) {
    created = await record('databases/create', 'setup', ({ step, spawned }) =>
      run('make', ['-s', 'databases-create', `SERVERS=${serverFile}`, `DIRECTORY=${directory}`, `NAME=${name}`], step, spawned, { guard: false }));
    if (!created) failedSetup['databases'] = `the setup step databases/create failed: ${(results.at(-1)?.failures ?? []).join(' / ')}`;
  }
  for (const target of targets) {
    const blocked = needsOf(target).find(need => failedSetup[need]);
    if (blocked) {
      skip(target, failedSetup[blocked] ?? '');
      continue;
    }
    await record(target, 'target', async ({ step, spawned, options }) => {
      // The sub-make uses this checkout's Rust target directory as set by the Makefile (AGENTS.md).
      // -k runs the unrelated sub-targets of a recipe even if one of its sub-targets fails.
      await run('make', ['--no-print-directory', '-k', `TEST_ENV=${created ? testEnv : servers ?? ''}`, `DECIMAL_ENV=${decimalEnv}`, target], step, spawned, options);
    });
  }
  // A database is removed to the extent it was created, even if creating it fails midway.
  if (serversReady)
    await record('databases/drop', 'setup', ({ step, spawned }) =>
      run('node', ['scripts/check/databases.mts', 'drop', serverFile, directory, name], step, spawned, { guard: false }));

  for (const { label, passed, notRun, elapsed } of results)
    console.log(`check: ${notRun ? 'NOT-RUN' : passed ? 'PASS' : 'FAIL'} ${label} elapsed=${duration(elapsed)}${notRun ? `: ${notRun}` : ''}`);
  // Report writes and record writes that fail outside a step also remain in the run's record and summary.
  const stepErrors = new Set(results.flatMap(result => result.reportErrors ?? []));
  const runErrors = [...writer.failed.filter(error => !stepErrors.has(error)), ...recorder.writeErrors];
  if (current && runErrors.length) current.reportErrors = runErrors;
  const finished = recorder.finish();
  const failed = results.filter(result => !result.passed);
  const writeFailures = writer.failed.length + recorder.writeErrors.length;
  if (writeFailures) console.log(`check: ${writeFailures} report or record write(s) failed:\n${[...writer.failed, ...recorder.writeErrors].join('\n')}`);
  if (failed.length) console.log(`check: ${failed.length} of ${results.length} step(s) failed or did not run; report ${relative(root, report)}`);
  // The summary is built from the record. For runs that are jobSummary (make run-databases, make bench, and make docs-ci run by the docs job in ci.yml),
  // that summary is also written to GITHUB_STEP_SUMMARY: after such a run there is no summary step (scripts/check/summary.mts).
  writer.run(join(report, 'summary.md'), () => publish(summary(finished, { run: current, report: relative(root, report) }), report, { step: jobSummary }));
  active = null;
  return failed.length || writeFailures ? 1 : 0;
}

// active is the run in progress. Errors the runner did not handle (uncaughtException, unhandledRejection) are recorded by the crash handler.
let active: { recorder: Recorder; writer: ReportWriter; report: string; root: string; current: RunRecord } | null = null;

// handleCrashes records unhandled errors (uncaughtException, unhandledRejection) as a crash and makes the process exit with 1.
export function handleCrashes() {
  for (const event of ['uncaughtException', 'unhandledRejection'])
    process.on(event, (error: unknown) => { crash(error); process.exit(1); });
}

// crash records the unhandled error in the run record as `runner error: <stack>`, marks the run as crashed, and then writes the summary.
// That write also does not throw. The caller ends with a non-zero status.
export function crash(error: unknown): void {
  const reason = `runner error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  console.error(`check: ${reason}`);
  if (!active) return;
  const { recorder, writer, report, root, current } = active;
  active = null;
  const record = recorder.crash(reason);
  if (record) writer.run(join(report, 'summary.md'), () => publish(summary(record, { run: current, report: relative(root, report), crashed: reason }), report));
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const jobSummary = args[0] === '--job-summary';
  if (jobSummary) args.shift();
  const [serversArgument, ...targets] = args;
  const valid = serversArgument && targets.length > 0 && targets.every(target => /^[a-z0-9-]+$/.test(target));
  if (!valid) {
    console.error('usage: node scripts/check/run.mts [--job-summary] <servers env | -> <target>...');
    process.exit(2);
  }
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  handleCrashes();
  // Every 30 seconds it writes memory, disk, the processes with large RSS, and the group signals sent, to stdout (scripts/check/resources.mts).
  const stopMonitor = monitor();
  // servers `-` is a run without a server.
  process.exitCode = await runChecks({ root, jobSummary, servers: serversArgument === '-' ? null : resolve(serversArgument), targets, run: command(root) });
  stopMonitor();
}
