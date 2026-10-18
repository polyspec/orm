// Conformance checker: runs the client runners (or reads their outputs) and compares each vector's statements and result
// against tests/conformance/vectors.json with exact JSON number comparison and sorted object keys in diagnostics.
//
//   node tests/conformance/check/main.mts run --out <new dir> --dsn … [--driver postgres|sqlite]   # run all five runners twice, then compare
//   node tests/conformance/check/main.mts run --out <new dir> --driver mysql --dsn … --driver postgres --dsn … --driver sqlite --dsn …   # build once, check each database
//   node tests/conformance/check/main.mts compare [--driver …] out/…                                   # compare produced outputs (<lang>.json)
//   node tests/conformance/check/main.mts record [--driver …] out/{go,php,rust,typescript,python}.json   # record agreed expectations
//   node tests/conformance/check/main.mts state --driver … --dsn …                                      # print the state digest of a database
//
// `run` writes the verified outputs of a database into --out (MySQL) or --out/<driver>, a directory that must not exist
// yet: every run starts from an empty directory of its own, so no reader takes the outputs of an earlier run for this one.
// --vector, repeatable, runs, compares and records only the named vectors.
//
// Expectations live in tests/conformance/vectors.json (MySQL) and tests/conformance/vectors.<driver>.json for the other
// databases: statements differ per dialect, results must not.
//
// `run` holds a holder lock (@polyspec/kit/holder-lock) per bench database (orm-conformance-<DSN hash>.lock in the
// temporary directory) while the runners use it; a second run on the same database fails instead of waiting, naming the
// holder, runs on other databases do not conflict, and the lock of a run that ended in any way no longer holds: a lock
// whose holder has ended is removed and taken.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { acquireHolderLock, HolderLockRefused, holderRunning, removeDeadLock } from '@polyspec/kit/holder-lock';
import { COMPUTE, runCase, runLong, stepLines, type Step } from '../../testcase.mts';
import { errorMessage } from '../../errors.mts';
import { checkJson } from '../../../scripts/json/schema.mts';
import { clientLanguages } from '../../../scripts/features/languages.mts';
import { readCounters, restoreCounters } from './counters.mts';
import { openStateDatabase, type StateDatabase } from './database.mts';
import { compact, decodeExact, encode, equalJSON, equalValues, type Json, type JsonObject } from './json.mts';
import { snapshotDatabase } from './state.mts';
import { changeLine, diff, statementGroup, summary, type Change, type Statement } from './stmtdiff.mts';

const repository = resolve(import.meta.dirname, '../../..');
const vectorListSchema = join(repository, 'scripts/schema/conformance-vector-list.schema.json');
const outputSchema = join(repository, 'scripts/schema/conformance-output.schema.json');

// Deadlines for running the runner and checking it. The runner's build is a long task, so it runs once per run with no deadline (runLong, with the command
// output as steps), and the built runner runs against all databases, twice.
// runnerDeadline: one built runner process runs all vectors on the bench database (1-3 s on the development machine).
// A runner that runs longer than 1 minute is stuck.
const runnerDeadline = 60_000;
// stateDeadline: the deadline for one read-and-restore of the database state digest (state.mts) or the counter (counters.mts). The bench
// database's digest is read within 1 s.
export const stateDeadline = 60_000;
// languageDeadline: a case for one language runs the runner twice, and for each run reads the state before and after and restores the counter (8 min).
export const languageDeadline = 2 * runnerDeadline + 6 * stateDeadline;
// compareDeadline: an in-memory computation that compares the five outputs with the vector expected values.
const compareDeadline = COMPUTE;

export const requiredLanguages = clientLanguages();

/** The database a run uses and the vectors it selects; an empty selection is every vector. */
export type Target = { driver: string; dsn: string; selected: string[] };

/** The context of a case or a long task: its step writer and, for a case, the signal of its deadline. */
export type Context = { step: Step; signal?: AbortSignal };

/** A vector as the checker reads it: its name, its chain, the methods it verifies and its expectation (undefined when none is recorded). */
type Vector = { name: string; chain: string; calls: string[]; expect: Json | undefined };

/** The usage of the program: it ends the program with the exit status 2. */
class UsageError extends Error {}

const USAGE = 'usage: check state --dsn x [--driver d] | check run --out <new dir> [--driver d] --dsn x [--driver d --dsn x]... | check compare|record [--driver d] <go.json> <php.json> <rust.json> <typescript.json> <python.json>';

/** vectorsPath is the expectations file of a database, relative to the repository. */
export function vectorsPath(driver: string): string {
  return driver === '' || driver === 'mysql' ? 'tests/conformance/vectors.json' : `tests/conformance/vectors.${driver}.json`;
}

const chosen = (selected: string[], name: string): boolean => selected.length === 0 || selected.includes(name);

/** joinErrors is one error of the errors that are not null, each on its own line, or null when there is none (errors.Join of Go). */
function joinErrors(errors: unknown[]): Error | null {
  const list = errors.filter(error => error !== null && error !== undefined);
  if (list.length === 0) return null;
  return new AggregateError(list, list.map(errorMessage).join('\n'));
}

/** errorIncludes is whether the error is target, or wraps or joins it. */
export function errorIncludes(error: unknown, target: unknown): boolean {
  if (error === target) return true;
  if (error instanceof AggregateError && error.errors.some(inner => errorIncludes(inner, target))) return true;
  return error instanceof Error && error.cause !== undefined && errorIncludes(error.cause, target);
}

const wrap = (prefix: string, error: unknown): Error => new Error(`${prefix}: ${errorMessage(error)}`, { cause: error });

/**
 * newOutputDirectory makes the output directory of a run. It refuses one that exists: a run always writes into an empty
 * directory of its own, so no file of an earlier run is read as this run's output.
 */
export function newOutputDirectory(path: string): void {
  if (statSync(path, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`output directory ${path} already exists; run writes into a new directory of its own so that no earlier output is read as this run's`);
  }
  mkdirSync(path, { recursive: true });
}

// caseError runs a case with a deadline and returns its error, or null when it passed.
async function caseError(name: string, deadline: number, body: (context: Required<Context>) => Promise<void>): Promise<Error | null> {
  let failure: unknown = null;
  const passed = await runCase(name, deadline, async context => {
    try {
      await body(context);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  return passed ? null : failure instanceof Error ? failure : new Error(`${name} failed: ${errorMessage(failure)}`);
}

// longError runs a long task without a deadline and returns its error, or null when it passed.
export async function longError(name: string, body: (context: Context) => Promise<void>): Promise<Error | null> {
  let failure: unknown = null;
  const passed = await runLong(name, async context => {
    try {
      await body(context);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  return passed ? null : failure instanceof Error ? failure : new Error(`${name} failed: ${errorMessage(failure)}`);
}

const driverDir = (driver: string): string => driver === 'mysql' ? '' : driver;

/**
 * runDatabase runs the five runners twice each on the target database, checking its state, compares the outputs with the
 * vector expectations and leaves the verified outputs in outRoot (MySQL) or outRoot/<driver>.
 */
async function runDatabase(root: string, outRoot: string, target: Target): Promise<void> {
  const out = join(outRoot, driverDir(target.driver));
  mkdirSync(out, { recursive: true });
  const pending = mkdtempSync(join(out, '.run-'));
  const stateDB = await openStateDatabase(target.driver, target.dsn);
  // Every language runs on this database, also after one failed: the comparison needs all of them, and the failures name
  // each language that failed.
  let languageError: Error | null;
  try {
    languageError = await runLanguages(requiredLanguages, async language => {
      const first = join(pending, `${language}.json`);
      const repeated = join(pending, `${language}.repeat.json`);
      const failed = await caseError(`conformance/${target.driver}/${language}`, languageDeadline,
        context => runLanguage(context, stateDB, root, target, language, first, repeated));
      if (failed) throw failed;
      rmSync(repeated);
    });
  } finally {
    await stateDB.close();
  }
  if (languageError) {
    const removed = (() => {
      try {
        rmSync(pending, { recursive: true, force: true });
        return null;
      } catch (error) {
        return error;
      }
    })();
    throw joinErrors([languageError, removed]) ?? languageError;
  }
  const files = requiredLanguages.map(language => join(pending, `${language}.json`));
  const compared = await caseError(`conformance/${target.driver}/compare`, compareDeadline, async () => {
    if (compare(root, files, target.driver, target.selected) !== 0) throw new Error(`conformance comparison failed; output retained in ${pending}`);
  });
  if (compared) throw compared;
  for (const language of requiredLanguages) renameSync(join(pending, `${language}.json`), join(out, `${language}.json`));
  rmdirSync(pending);
  console.log(`conformance: verified outputs saved in ${out}`);
}

/**
 * runLanguages runs run for each language in order, also after a language failed, and returns one error that names each
 * language that failed, or null when every language passed.
 */
export async function runLanguages(languages: string[], run: (language: string) => Promise<void>): Promise<Error | null> {
  const failures: Error[] = [];
  for (const language of languages) {
    try {
      await run(language);
    } catch (error) {
      failures.push(wrap(language, error));
    }
  }
  return joinErrors(failures);
}

/**
 * runAndCheckState runs run between two state digests of the database and restores the counters that it advanced; the
 * error joins the error of run with a changed state, so a failed run that left a row behind reports both.
 */
export async function runAndCheckState(db: StateDatabase, database: string, language: string, phase: string, run: () => Promise<void>): Promise<void> {
  const before = await snapshotDatabase(db, database);
  const counters = await readCounters(db, database);
  const attempt = async (work: () => Promise<unknown>): Promise<unknown> => {
    try {
      await work();
      return null;
    } catch (error) {
      return error;
    }
  };
  const runError = await attempt(run);
  const restoreError = await attempt(() => restoreCounters(db, database, counters));
  let after = '';
  const snapshotError = await attempt(async () => { after = await snapshotDatabase(db, database); });
  const stateError = snapshotError === null && before !== after ? new Error(`${language} changed ${database} database state on ${phase} run`) : null;
  const joined = joinErrors([runError, restoreError, snapshotError, stateError]);
  if (joined) throw joined;
}

/**
 * lockPath is the lock file held while a bench database is in use. The runners write to the database and undo their
 * writes, so two runs on the same database must not overlap. The name is a hash of the DSN; the file lives in the
 * temporary directory.
 */
function lockPath(dsn: string): string {
  return join(tmpdir(), `orm-conformance-${createHash('sha256').update(dsn).digest('hex').slice(0, 16)}.lock`);
}

/** The locks this process holds, released when the run ends. */
const held: { path: string; release: () => void }[] = [];

/**
 * lockDatabases takes the lock of each DSN's database. A lock whose holder has ended is removed and taken; a lock that a
 * running process holds fails at once, naming that process.
 */
export function lockDatabases(...dsns: string[]): void {
  for (const value of dsns) {
    const path = lockPath(value);
    if (held.some(lock => lock.path === path)) continue;
    held.push({ path, release: takeLock(path) });
  }
}

function takeLock(path: string): () => void {
  for (;;) {
    try {
      return acquireHolderLock(path, { command: 'conformance check' }).release;
    } catch (error) {
      if (!(error instanceof HolderLockRefused)) throw error;
      if (holderRunning(error.record)) throw new Error(`another conformance run (pid ${error.record.pid}) holds ${path}: ${error.message}`, { cause: error });
      // The holder ended without releasing the lock (killed): the lock no longer holds.
      removeDeadLock(path);
    }
  }
}

/** releaseLocks releases every lock this process holds. */
export function releaseLocks(): void {
  const errors: unknown[] = [];
  for (const lock of held.splice(0)) {
    try {
      lock.release();
    } catch (error) {
      errors.push(error);
    }
  }
  const joined = joinErrors(errors);
  if (joined) throw joined;
}

/**
 * runLanguage runs one language's runner twice, checking each time that the database state stays, and compares the two
 * outputs.
 */
export async function runLanguage(context: Context, stateDB: StateDatabase, root: string, target: Target, language: string, first: string, repeated: string): Promise<void> {
  context.step('first run');
  await runAndCheckState(stateDB, target.driver, language, 'first', () => runOne(context, root, target, first, language));
  context.step('repeated run');
  await runAndCheckState(stateDB, target.driver, language, 'repeated', () => runOne(context, root, target, repeated, language));
  context.step('compare the two outputs');
  compareRepeatedEvidence(first, repeated);
}

/** The built runners: the Go runner that buildRunners builds and the Rust runner that buildRustRunner copies. */
const runners = { go: '', rust: '' };

/**
 * buildRustRunner builds the Rust runner under the exclusive lease of the shared Rust target directory (LEASE,
 * CARGO_LEASES, --wait) and copies it within that lease into the directory (scripts/cargo-build-copy.mts). The runs use
 * the copy, so a build of another run of this checkout that changes the target directory does not change this run's
 * runner.
 */
export async function buildRustRunner(context: Context, root: string, directory: string): Promise<void> {
  const lease = process.env.LEASE ?? '';
  const leases = process.env.CARGO_LEASES ?? '';
  if (lease === '' || leases === '') throw new Error('LEASE and CARGO_LEASES are unset; run this through make, which exports them');
  await runCommand(context, root, '', 0, lease, ['run', leases, 'exclusive', '--wait', '--', 'node', join(root, 'scripts', 'cargo-build-copy.mts'), directory, 'debug/conformance', '--',
    'cargo', 'build', '--locked', '--manifest-path', 'packages/rust/Cargo.toml', '-p', 'polyspec-orm-tests', '--bin', 'conformance']);
  runners.rust = join(directory, 'debug', 'conformance');
}

/** buildRunners builds the Rust runner, the TypeScript client and the Go runner once; the Go and Rust runners stay in directory. */
export async function buildRunners(context: Context, root: string, directory: string): Promise<void> {
  await buildRustRunner(context, root, directory);
  await runCommand(context, root, '', 0, 'npm', ['run', 'build', '--prefix', 'packages/ts']);
  const binary = join(directory, 'runner_go');
  await runCommand(context, root, '', 0, 'go', ['build', '-tags', 'ormtest', '-o', binary, './packages/go/internal/conformance']);
  runners.go = binary;
}

async function runOne(context: Context, root: string, target: Target, output: string, language: string): Promise<void> {
  const flags = ['--dsn', target.dsn, ...target.selected.flatMap(name => ['--vector', name])];
  const goFlags = ['-dsn', target.dsn, ...target.selected.flatMap(name => ['-vector', name])];
  switch (language) {
    case 'go':
      if (runners.go === '') throw new Error('go runner is not built');
      return runCommand(context, root, output, runnerDeadline, runners.go, goFlags);
    case 'php': {
      // PHP does not read TZ, it reads date.timezone. It runs with the time zone of TZ, as the other runners do.
      const zone = process.env.TZ ?? '';
      return runCommand(context, root, output, runnerDeadline, 'php', [...(zone === '' ? [] : ['-d', `date.timezone=${zone}`]), 'packages/php/testing/conformance/runner.php', ...flags]);
    }
    case 'typescript':
      return runCommand(context, root, output, runnerDeadline, 'node', ['packages/ts/testing/conformance/runner_typescript.mts', ...flags]);
    case 'rust':
      if (runners.rust === '') throw new Error('rust runner is not built');
      return runCommand(context, root, output, runnerDeadline, runners.rust, flags);
    case 'python': {
      const interpreter = process.env.ORM_PYTHON ?? '';
      const models = process.env.ORM_PYTHON_MODELS ?? '';
      if (interpreter === '' || models === '') throw new Error('ORM_PYTHON and ORM_PYTHON_MODELS are unset; run make conformance-check, which sets both and builds the models');
      return runCommand(context, root, output, runnerDeadline, interpreter, ['packages/python/testing/conformance/runner_python.py', '--models', models, ...flags]);
    }
    default:
      throw new Error(`unsupported language ${JSON.stringify(language)}`);
  }
}

/**
 * runCommand runs one command within the earlier of timeout (ms) and the deadline of the context's case, and writes its
 * start and its output lines as steps of the context. The standard output goes to the file output, or to the steps when
 * output is empty. A timeout of 0 is a long task (a build), which has no timeout.
 */
export async function runCommand(context: Context, root: string, output: string, timeout: number, name: string, args: string[]): Promise<void> {
  const signals = [context.signal, timeout > 0 ? AbortSignal.timeout(timeout) : undefined].filter(signal => signal !== undefined);
  const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
  const steps = stepLines(context.step);
  const stdout: Buffer[] = [];
  context.step(`run ${displayCommand([name, ...args])}`);
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: Error }>(done => {
    const child = spawn(name, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...(signal === undefined ? {} : { signal }), killSignal: 'SIGKILL' });
    child.stderr.on('data', (chunk: Buffer) => steps.write(chunk));
    child.stdout.on('data', (chunk: Buffer) => { if (output === '') steps.write(chunk); else stdout.push(chunk); });
    child.on('error', error => { if (child.pid === undefined) done({ error }); });
    child.on('close', (code, ended) => done({ code, signal: ended }));
  });
  steps.flush();
  if (signal?.aborted) throw new Error(`${name}: ${errorMessage(signal.reason)}`);
  if ('error' in ended) throw wrap(name, ended.error);
  if (ended.code !== 0) throw new Error(`${name}: ${ended.code === null ? `signal: ${ended.signal}` : `exit status ${ended.code}`}`);
  if (output !== '') writeFileSync(output, Buffer.concat(stdout), { mode: 0o644 });
}

/** displayCommand is a command line with the value of each --dsn or -dsn flag redacted. */
export function displayCommand(args: string[]): string {
  return args.map((arg, index) => index > 0 && (args[index - 1] === '--dsn' || args[index - 1] === '-dsn') ? '<redacted>' : arg).join(' ');
}

const languageOf = (output: string): string => basename(output).replace(/\.json$/, '');

/** validateOutputFiles accepts exactly one <lang>.json for each required language. */
export function validateOutputFiles(outputs: string[]): void {
  if (outputs.length !== requiredLanguages.length) throw new Error(`conformance requires ${requiredLanguages.length} language outputs, got ${outputs.length}`);
  const want = new Set(requiredLanguages);
  for (const output of outputs) {
    const language = languageOf(output);
    if (extname(output) !== '.json' || !want.has(language)) throw new Error(`duplicate or unknown language output ${JSON.stringify(output)}`);
    want.delete(language);
  }
}

/** compareRepeatedEvidence refuses two outputs of one runner that differ. */
export function compareRepeatedEvidence(first: string, second: string): void {
  if (!equalJSON(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'))) throw new Error(`conformance output changed between runs: ${first}`);
}

// readExact reads a JSON file exactly and checks its shape against a schema; an error names the file.
function readExact(path: string, schema: string): Json {
  const text = readFileSync(path, 'utf8');
  try {
    const value = decodeExact(text);
    checkJson<unknown>(JSON.parse(text), schema, path);
    return value;
  } catch (error) {
    throw wrap(path, error);
  }
}

// vectorsOf reads the vector list of an exactly read file whose shape the vector list schema accepted.
function vectorsOf(value: Json): Vector[] {
  const list = value instanceof Map ? value.get('vectors') : undefined;
  if (!Array.isArray(list)) return [];
  return list.map(item => {
    const fields = item instanceof Map ? item : new Map<string, Json>();
    const name = fields.get('name');
    const chain = fields.get('chain');
    const calls = fields.get('calls');
    return {
      name: typeof name === 'string' ? name : '',
      chain: typeof chain === 'string' ? chain : '',
      calls: Array.isArray(calls) ? calls.filter((call): call is string => typeof call === 'string') : [],
      expect: fields.get('expect'),
    };
  });
}

/**
 * load reads the vector list (names and chains) from vectors.json, the single place a vector is declared, and, for
 * another database, overlays the expectations recorded for that dialect (vectors.<driver>.json).
 */
export function load(root: string, driver: string): Vector[] {
  const basePath = join(root, 'tests/conformance/vectors.json');
  const vectors = vectorsOf(readExact(basePath, vectorListSchema));
  const declared = vectorNames(vectors, basePath);
  if (driver === 'mysql') return vectors;
  const dialectPath = join(root, vectorsPath(driver));
  const recorded = vectorNames(vectorsOf(readExact(dialectPath, vectorListSchema)), dialectPath);
  for (const name of recorded.keys()) if (!declared.has(name)) throw new Error(`${dialectPath}: undeclared vector ${name}`);
  return vectors.map(vector => {
    const dialect = recorded.get(vector.name);
    if (dialect === undefined) throw new Error(`${dialectPath}: missing vector ${vector.name}`);
    return { ...vector, expect: dialect.expect };
  });
}

function vectorNames(vectors: Vector[], path: string): Map<string, Vector> {
  if (vectors.length === 0) throw new Error(`${path}: no vectors`);
  const names = new Map<string, Vector>();
  for (const vector of vectors) {
    if (vector.name === '') throw new Error(`${path}: empty vector name`);
    if (names.has(vector.name)) throw new Error(`${path}: duplicate vector ${vector.name}`);
    names.set(vector.name, vector);
  }
  return names;
}

const indented = (value: Json): string => encode(value, { indent: '  ', sorted: true });

// fieldsOf is a value as the fields of an object: null is an object without fields (a nil map of Go), any other value
// that is not an object is undefined.
function fieldsOf(value: Json | undefined): JsonObject | undefined {
  if (value === null || value === undefined) return new Map();
  return value instanceof Map ? value : undefined;
}

/**
 * describeDifference describes how an output differs from the vector expectation: a different result by both values, the
 * statements by the statements added or missing with their position, kind, SQL, binds and error (stmtdiff), any other
 * field by both values.
 */
export function describeDifference(want: Json | undefined, got: Json): string[] {
  const expected = fieldsOf(want);
  const actual = fieldsOf(got);
  if (expected === undefined || actual === undefined) return [`expected ${indented(want ?? null)}`, `got ${indented(got)}`];
  const lines: string[] = [];
  const keys = [...new Set([...expected.keys(), ...actual.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const key of keys) {
    const e = expected.get(key);
    const a = actual.get(key);
    if (e === undefined) {
      lines.push(`${key}: not expected, got ${indented(a ?? null)}`);
    } else if (a === undefined) {
      lines.push(`${key}: missing, expected ${indented(e)}`);
    } else if (key === 'statements') {
      let changes: Change[];
      try {
        changes = statementChanges(e, a);
      } catch (error) {
        lines.push(`statements: ${errorMessage(error)}; expected ${indented(e)}, got ${indented(a)}`);
        continue;
      }
      if (changes.length === 0) continue;
      lines.push(`statements: ${summary(changes, statementGroup)}`, ...changes.map(change => `  ${changeLine(change)}`));
    } else if (!equalValues(e, a)) {
      lines.push(`${key}: expected ${compact(e)}, got ${compact(a)}`);
    }
  }
  return lines;
}

// statementChanges is the difference of two statement lists. A statement is compared by its whole JSON with sorted keys.
function statementChanges(want: Json, got: Json): Change[] {
  const convert = (value: Json): Statement[] => {
    if (value === null) return [];
    if (!Array.isArray(value)) throw new Error(`not a statement list: ${compact(value)} is not an array`);
    return value.map((item, index) => {
      const fields = fieldsOf(item);
      if (fields === undefined) throw new Error(`statement ${index + 1}: ${compact(item)} is not an object`);
      const kind = fields.get('kind') ?? '';
      const sql = fields.get('sql') ?? '';
      if (typeof kind !== 'string' && kind !== null) throw new Error(`statement ${index + 1}: kind ${compact(kind)} is not text`);
      if (typeof sql !== 'string' && sql !== null) throw new Error(`statement ${index + 1}: sql ${compact(sql)} is not text`);
      const error = fields.get('error');
      let text = `${sql ?? ''} binds ${compact(fields.get('binds'))}`;
      if (error !== undefined && error !== null) text += ` error ${compact(error)}`;
      return { kind: kind ?? '', text, key: compact(item) };
    });
  };
  return diff(convert(want), convert(got));
}

// readOutput reads the output of one runner: each vector's name with its output.
function readOutput(path: string): JsonObject {
  return fieldsOf(readExact(path, outputSchema)) ?? new Map();
}

/** compare compares each runner's output with the vector expectations, prints a line per vector and returns the exit status. */
export function compare(root: string, outputs: string[], driver: string, selected: string[] = []): number {
  let vectors: Vector[];
  try {
    validateOutputFiles(outputs);
    vectors = load(root, driver);
  } catch (error) {
    console.error(`check: ${errorMessage(error)}`);
    return 1;
  }
  const languages = outputs.map(languageOf);
  const results = new Map(outputs.map(output => [languageOf(output), readOutput(output)]));
  let failed = 0;
  let compared = 0;
  const declared = new Set<string>();
  for (const vector of vectors) {
    declared.add(vector.name);
    if (!chosen(selected, vector.name)) continue;
    compared++;
    if (vector.expect === undefined || vector.expect === null) {
      console.log(`${vector.name.padEnd(22)} (no expectation recorded)`);
      failed++;
      continue;
    }
    let line = vector.name.padEnd(22);
    const diffs: string[] = [];
    for (const language of languages) {
      const got = results.get(language)?.get(vector.name);
      if (got === undefined) {
        line += ` ${language}:MISSING`;
        failed++;
        continue;
      }
      if (!equalValues(got, vector.expect)) {
        line += ` ${language}:DIFF`;
        failed++;
        diffs.push(`--- ${vector.name}: ${language} output differs from ${vectorsPath(driver)}\n${describeDifference(vector.expect, got).join('\n')}\n`);
      } else {
        line += ` ${language}:ok`;
      }
    }
    console.log(line);
    for (const text of diffs) process.stdout.write(text);
  }
  for (const language of languages) {
    for (const name of results.get(language)?.keys() ?? []) {
      if (!declared.has(name)) {
        console.log(`${name.padEnd(22)} ${language}:UNDECLARED`);
        failed++;
      }
    }
  }
  if (failed === 0) {
    console.log(`conformance: ${compared} vectors × ${languages.length} languages identical`);
    return 0;
  }
  console.log(`conformance: ${failed} mismatches`);
  return 1;
}

/**
 * recordVerified records the outputs as the expectations of the database when all five agree, for every selected vector;
 * it writes the file through a temporary file and a rename, and refuses incomplete, conflicting or undeclared evidence
 * without changing the file.
 */
export function recordVerified(root: string, outputs: string[], driver: string, selected: string[] = []): void {
  validateOutputFiles(outputs);
  const vectors = load(root, driver);
  const results = new Map(outputs.map(output => [languageOf(output), readOutput(output)]));
  const declared = new Set<string>();
  for (const vector of vectors) {
    declared.add(vector.name);
    if (!chosen(selected, vector.name)) continue;
    const agreed = results.get('go')?.get(vector.name);
    if (agreed === undefined) throw new Error(`vector ${vector.name} missing from go output`);
    for (const language of requiredLanguages.slice(1)) {
      const other = results.get(language)?.get(vector.name);
      if (other === undefined) throw new Error(`vector ${vector.name} missing from ${language} output`);
      if (!equalValues(agreed, other)) throw new Error(`vector ${vector.name} differs between go and ${language} outputs`);
    }
    // The expectation is recorded with sorted keys; the vectors not selected keep theirs as they are.
    vector.expect = decodeExact(compact(agreed));
  }
  for (const language of requiredLanguages) {
    for (const name of results.get(language)?.keys() ?? []) {
      if (!declared.has(name)) throw new Error(`${language} output has undeclared vector ${JSON.stringify(name)}`);
    }
  }
  const document: Json = new Map([['vectors', vectors.map((vector): Json => new Map<string, Json>([
    ['name', vector.name], ['chain', vector.chain], ['calls', vector.calls], ['expect', vector.expect ?? null]]))]]);
  const path = join(root, vectorsPath(driver));
  const temporary = join(dirname(path), `.vectors-${process.pid}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}`);
  try {
    writeFileSync(temporary, `${encode(document, { indent: '  ', sorted: false })}\n`, { flag: 'wx', mode: 0o644 });
    chmodSync(temporary, 0o644);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`recorded ${vectors.length} agreed vectors into ${vectorsPath(driver)}`);
}

/** main runs the command of argv and returns the exit status. */
async function main(argv: string[]): Promise<number> {
  try {
    return await command(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(USAGE);
      return 2;
    }
    console.error(`check: ${errorMessage(error)}`);
    return 1;
  } finally {
    try {
      releaseLocks();
    } catch (error) {
      console.error(`check: release conformance lock: ${errorMessage(error)}`);
    }
  }
}

async function command(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError();
  let parsed;
  try {
    parsed = parseArgs({
      args: rest, allowPositionals: true, strict: true,
      options: { driver: { type: 'string', multiple: true }, dsn: { type: 'string', multiple: true }, out: { type: 'string' }, vector: { type: 'string', multiple: true } },
    });
  } catch {
    throw new UsageError();
  }
  const drivers = parsed.values.driver ?? ['mysql'];
  const dsns = parsed.values.dsn ?? [];
  const outRoot = parsed.values.out ?? '';
  const selected = parsed.values.vector ?? [];
  for (const driver of drivers) {
    if (!['mysql', 'postgres', 'sqlite'].includes(driver)) throw new Error(`unsupported database ${JSON.stringify(driver)}`);
  }
  if (dsns.length > drivers.length || (drivers.length > 1 && (dsns.length !== drivers.length || name !== 'run'))) throw new UsageError();
  const driver = drivers[0] ?? 'mysql';
  const dsn = dsns[0] ?? '';
  const root = process.cwd();
  switch (name) {
    case 'state': {
      if (dsn === '') throw new UsageError();
      const db = await openStateDatabase(driver, dsn);
      try {
        console.log(`${driver} state ${await snapshotDatabase(db, driver)}`);
      } finally {
        await db.close();
      }
      return 0;
    }
    case 'run': {
      if (dsns.length !== drivers.length || dsns.includes('') || outRoot === '') throw new UsageError();
      newOutputDirectory(outRoot);
      lockDatabases(...dsns);
      const binaries = mkdtempSync(join(tmpdir(), 'orm-conformance-runners-'));
      try {
        const built = await longError('conformance/build', context => buildRunners(context, root, binaries));
        if (built) throw built;
        // A failed database does not stop the others: every database runs, and the run fails naming each one that failed.
        const failures: Error[] = [];
        for (const [index, database] of drivers.entries()) {
          try {
            await runDatabase(root, outRoot, { driver: database, dsn: dsns[index] ?? '', selected });
          } catch (error) {
            failures.push(wrap(database, error));
          }
        }
        const failed = joinErrors(failures);
        if (failed) throw failed;
      } finally {
        rmSync(binaries, { recursive: true, force: true });
      }
      return 0;
    }
    case 'compare':
      return compare(root, parsed.positionals, driver, selected);
    case 'record':
      recordVerified(root, parsed.positionals, driver, selected);
      return 0;
    default:
      throw new UsageError();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
