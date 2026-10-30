#!/usr/bin/env node
// Own the servers and run databases of one Kit parity job. The provider calls prepare and cleanup in
// separate workflow steps, so the run directory and database DSNs cross that boundary only through the job's GITHUB_ENV.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { environmentFile } from './databases.mts';

const SERVER_ENV = '.runtime/servers/env';
const RUN_PARENT = '.runtime/run';
const markerName = '.kit-parity-context.json';

export type ContextScope = 'parity' | 'php-ext';
type ContextState = { schema: 1; scope: ContextScope; runId: string; attempt: string; serverStartAttempted: boolean; databaseCreateAttempted: boolean };
export type ContextCommandResult = { status: number | null; signal: NodeJS.Signals | null };
export type ContextCommand = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ContextCommandResult;

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ContextCommandResult {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  return { status: result.status, signal: result.signal };
}

function identity(scope: ContextScope, env: NodeJS.ProcessEnv): { runId: string; attempt: string; name: string } {
  const runId = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '';
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) {
    throw new Error(`GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be numeric for an owned ${scope} context; set them in the workflow environment`);
  }
  return { runId, attempt, name: `orm_kit_${scope.replace('-', '_')}_${runId}_${attempt}` };
}

function contextPath(root: string, scope: ContextScope, runId: string, attempt: string): string {
  return resolve(root, RUN_PARENT, `kit-${scope}-${runId}-${attempt}`);
}

function statePath(directory: string): string { return join(directory, markerName); }

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeState(directory: string, state: ContextState): void {
  const temporary = `${statePath(directory)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: 'w', mode: 0o600 });
  // Rename makes the ownership and progress marker readable as one complete record after interruption.
  renameSync(temporary, statePath(directory));
}

function readOwnedState(root: string, directory: string, scope: ContextScope, runId: string, attempt: string): ContextState {
  const parent = resolve(root, RUN_PARENT);
  const expected = contextPath(root, scope, runId, attempt);
  if (directory !== expected || basename(directory) !== `kit-${scope}-${runId}-${attempt}`) throw new Error(`refusing to use unexpected ${scope} context path ${directory}`);
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(parent);
  const directoryStat = lstatSync(directory);
  const expectedReal = join(parentReal, basename(expected));
  if (parentReal !== resolve(rootReal, RUN_PARENT) || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(directory) !== expectedReal) {
    throw new Error(`refusing to use ${scope} context outside ${parentReal}: ${directory}`);
  }
  const marker = statePath(directory);
  const markerStat = lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error(`refusing to use invalid ${scope} context ownership marker ${marker}`);
  const parsed: unknown = JSON.parse(readFileSync(marker, 'utf8'));
  if (!isObjectRecord(parsed)) throw new Error(`invalid parity context ownership marker ${marker}`);
  if (parsed.schema !== 1 || parsed.scope !== scope || parsed.runId !== runId || parsed.attempt !== attempt
      || typeof parsed.serverStartAttempted !== 'boolean' || typeof parsed.databaseCreateAttempted !== 'boolean') {
    throw new Error(`${scope} context ownership marker does not match workflow run ${runId}/${attempt}`);
  }
  return {
    schema: 1,
    scope,
    runId,
    attempt,
    serverStartAttempted: parsed.serverStartAttempted,
    databaseCreateAttempted: parsed.databaseCreateAttempted,
  };
}

const commandFailure = (result: ContextCommandResult): string => result.status === null
  ? `was terminated by ${result.signal ?? 'an unknown signal'} without an exit status`
  : `exited with ${result.status}`;

/** Prepare one workflow job's server/database resources and publish their paths to following Actions steps. */
export function prepareContext(scope: ContextScope, root: string = resolve(process.cwd()), env: NodeJS.ProcessEnv = process.env, command: ContextCommand = run): void {
  root = resolve(root);
  const { runId, attempt, name } = identity(scope, env);
  const githubEnv = env.GITHUB_ENV;
  if (!githubEnv) throw new Error(`GITHUB_ENV is unset; run ${scope} context preparation in a GitHub Actions job so its DSNs reach the gate step`);
  const directory = contextPath(root, scope, runId, attempt);
  if (existsSync(resolve(root, SERVER_ENV))) throw new Error(`${resolve(root, SERVER_ENV)} already exists; refusing to take ownership of another server context`);
  mkdirSync(resolve(root, RUN_PARENT), { recursive: true });
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const state: ContextState = { schema: 1, scope, runId, attempt, serverStartAttempted: false, databaseCreateAttempted: false };
  writeState(directory, state);

  state.serverStartAttempted = true;
  writeState(directory, state);
  const serversResult = command('make', ['--no-print-directory', 'orm-test-servers'], root, env);
  if (serversResult.status !== 0 || serversResult.signal !== null) {
    throw new Error(`make orm-test-servers ${commandFailure(serversResult)} for the ${scope} context; fix the pinned server setup and rerun the Kit gate`);
  }
  state.databaseCreateAttempted = true;
  writeState(directory, state);
  const testEnv = join(directory, 'env');
  const databaseSetup = ['--no-print-directory', 'databases-create', `SERVERS=${resolve(root, SERVER_ENV)}`, `DIRECTORY=${directory}`, `NAME=${name}`, 'COMPLEX_QUERY=1'];
  const databaseResult = command('make', databaseSetup, root, env);
  if (databaseResult.status !== 0 || databaseResult.signal !== null) {
    throw new Error(`${scope} database setup ${commandFailure(databaseResult)} for ${name}; inspect the setup output and rerun the Kit gate`);
  }
  // The decimal databases of the run are in decimal-env (databases.mts createDecimal); the Makefile assigns DECIMAL_ENV
  // itself, so its DSNs are exported as variables, as those of env are (T294).
  const decimalEnv = join(directory, 'decimal-env');
  for (const file of [testEnv, decimalEnv]) {
    if (!existsSync(file)) throw new Error(`${file} was not written by the database setup; fix scripts/check/databases.mts create`);
  }
  const exports = { ...environmentFile(readFileSync(testEnv, 'utf8')), ...environmentFile(readFileSync(decimalEnv, 'utf8')), TEST_ENV: testEnv, STEP_RUN_DIR: directory };
  for (const [key, value] of Object.entries(exports)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error(`${key} cannot be exported through GITHUB_ENV`);
  }
  appendFileSync(githubEnv, Object.entries(exports).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(`${scope} context ${runId}/${attempt} is ready; TEST_ENV, its database variables, the decimal DSNs and STEP_RUN_DIR are available to the provider gate`);
}

/** Drop the run databases, stop only the server set this context started, and remove only its marker-owned directory. */
export function cleanupContext(scope: ContextScope, root: string = resolve(process.cwd()), env: NodeJS.ProcessEnv = process.env, command: ContextCommand = run): void {
  root = resolve(root);
  const { runId, attempt, name } = identity(scope, env);
  const directory = contextPath(root, scope, runId, attempt);
  if (!existsSync(directory)) {
    console.log(`${scope} context ${runId}/${attempt} has no owned run directory to clean`);
    return;
  }
  const state = readOwnedState(root, directory, scope, runId, attempt);
  const failures: string[] = [];
  let retainRunDirectory = false;
  const servers = resolve(root, SERVER_ENV);
  if (state.databaseCreateAttempted && !existsSync(servers)) {
    failures.push(`database cleanup cannot run because ${servers} is missing`);
    retainRunDirectory = true;
  } else if (state.serverStartAttempted && existsSync(servers)) {
    const runCleanupOperation = (label: string, operation: () => ContextCommandResult) => {
      try {
        const result = operation();
        if (result.status !== 0 || result.signal !== null) failures.push(`${label} ${commandFailure(result)}`);
        return result.status === 0 && result.signal === null;
      } catch (error) {
        failures.push(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    if (state.databaseCreateAttempted) {
      runCleanupOperation('database cleanup', () => command('node', ['scripts/check/databases.mts', 'drop', servers, directory, name], root, env));
    }
    retainRunDirectory = !runCleanupOperation('server cleanup', () => command('make', ['--no-print-directory', 'orm-test-servers-stop'], root, env));
  }
  // Database drop normally removes this directory. Remove a partial setup only after server teardown; otherwise retain its files for diagnosis.
  if (existsSync(directory) && !retainRunDirectory) {
    try {
      readOwnedState(root, directory, scope, runId, attempt);
      rmSync(directory, { recursive: true });
    } catch (error) {
      failures.push(`owned context directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(`${scope} context cleanup failed: ${failures.join('; ')}`);
  console.log(`${scope} context ${runId}/${attempt} resources were cleaned`);
}

if (import.meta.main) {
  const action = process.argv[2];
  const scope = process.argv[3];
  try {
    if (scope !== 'parity' && scope !== 'php-ext') throw new Error('context scope must be parity or php-ext');
    if (action === 'prepare') prepareContext(scope);
    else if (action === 'cleanup') cleanupContext(scope);
    else throw new Error('usage: parity-context.mts prepare|cleanup parity|php-ext');
  } catch (error) {
    console.error(`parity-context: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
