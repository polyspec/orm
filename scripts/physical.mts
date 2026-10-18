// The shared steps of the physical checks (scripts/*-physical-check.mts): each runs owner tests against an isolated database
// and compares the database state before and after with the state reader of tests/conformance/check/main.mts.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { endGroup } from './check/step.mts';
import { runCase, type CaseBody } from '../tests/testcase.mts';
import { errorMessage } from '../tests/errors.mts';

/** TIMEOUT_MS is the deadline of one process: an owner test, orm-gen or the state reader. */
export const TIMEOUT_MS = 120_000;

/**
 * step runs one case; a run is an owner process and a state reader process, so its deadline is twice TIMEOUT_MS. A
 * failed case is reported with its reason and the check ends there.
 */
export async function step(name: string, deadline: number, body: CaseBody): Promise<void> {
  if (!(await runCase(name, deadline, body))) process.exit(1);
}

/** run starts program as the leader of its own process group and returns its standard output. */
export function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { env, detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      finish(new Error(`${program} timed out after ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', finish);
    // child is the leader of its own group. A process left in that group after it ends is treated as a failure (endGroup).
    const ended = new Promise<string[]>(resolve => child.on('exit', () => endGroup(child.pid).then(resolve, (error: unknown) => resolve([`its group could not be checked: ${errorMessage(error)}`]))));
    child.on('close', code => ended.then(left => finish(left.length ? new Error(`${program} left ${left.length} processes: ${left.join(', ')}`)
      : code === 0 ? null : new Error(`${program} exit ${code}: ${stderr || stdout}`))));
  });
}

/** state is the hash of the database state that the state reader reports; the DSN never appears in an error. */
export async function state(database: string, dsn: string): Promise<string> {
  let output: string;
  try { output = await run(process.execPath, [join(import.meta.dirname, '../tests/conformance/check/main.mts'), 'state', '--driver', database, '--dsn', dsn]); }
  catch (error) { throw new Error(errorMessage(error).replaceAll(dsn, '[redacted]')); }
  const match = new RegExp(`^${database} state ([a-f0-9]{64})\\n$`).exec(output);
  if (!match?.[1]) throw new Error(`${database}: invalid state reader output`);
  return match[1];
}
