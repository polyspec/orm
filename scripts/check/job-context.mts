#!/usr/bin/env node
// Own the run directory of one Kit CI job (the php-ext runtime job). Kit runs prepare, make -k ci-targets and cleanup in one
// step (ci-setup.mjs:203-207). The servers and the run databases are not started here: each target that reads them reaches
// orm-test-servers and databases-create as make prerequisites, so their owner is the ci-targets node of kit, which stops
// them when it ends (T645), and the Makefile derives the run directory from RUNTIME, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT
// (RUN_CONTEXT_DIR, T650). Prepare creates the directory with its ownership marker; cleanup checks the marker and removes it.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const RUN_PARENT = '.runtime/run';
const markerName = '.kit-job-context.json';

export type ContextScope = 'php-ext';
type ContextState = { schema: 2; scope: ContextScope; runId: string; attempt: string };

function identity(scope: ContextScope, env: NodeJS.ProcessEnv): { runId: string; attempt: string } {
  const runId = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '';
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) {
    throw new Error(`GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be numeric for an owned ${scope} context; set them in the workflow environment`);
  }
  return { runId, attempt };
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
  if (!isObjectRecord(parsed)) throw new Error(`invalid context ownership marker ${marker}`);
  if (parsed.schema !== 2 || parsed.scope !== scope || parsed.runId !== runId || parsed.attempt !== attempt) {
    throw new Error(`${scope} context ownership marker does not match workflow run ${runId}/${attempt}`);
  }
  return { schema: 2, scope, runId, attempt };
}

/** Create the owned run directory of one workflow job; the targets of make ci-targets start the servers and databases. */
export function prepareContext(scope: ContextScope, root: string = resolve(process.cwd()), env: NodeJS.ProcessEnv = process.env): void {
  root = resolve(root);
  const { runId, attempt } = identity(scope, env);
  const directory = contextPath(root, scope, runId, attempt);
  mkdirSync(resolve(root, RUN_PARENT), { recursive: true });
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  writeState(directory, { schema: 2, scope, runId, attempt });
  console.log(`${scope} context ${runId}/${attempt} owns ${directory}; the targets that read the servers start them and create its databases`);
}

/** Remove only the marker-owned run directory; the ci-targets node of kit already stopped the servers it owned. */
export function cleanupContext(scope: ContextScope, root: string = resolve(process.cwd()), env: NodeJS.ProcessEnv = process.env): void {
  root = resolve(root);
  const { runId, attempt } = identity(scope, env);
  const directory = contextPath(root, scope, runId, attempt);
  if (!existsSync(directory)) {
    console.log(`${scope} context ${runId}/${attempt} has no owned run directory to clean`);
    return;
  }
  readOwnedState(root, directory, scope, runId, attempt);
  rmSync(directory, { recursive: true });
  console.log(`${scope} context ${runId}/${attempt} run directory was removed`);
}

if (import.meta.main) {
  const action = process.argv[2];
  const scope = process.argv[3];
  try {
    if (scope !== 'php-ext') throw new Error('context scope must be php-ext');
    if (action === 'prepare') prepareContext(scope);
    else if (action === 'cleanup') cleanupContext(scope);
    else throw new Error('usage: job-context.mts prepare|cleanup php-ext');
  } catch (error) {
    console.error(`job-context: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
