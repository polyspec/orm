// The shared steps of the physical checks (scripts/*-physical-check.mts): each runs owner tests against an isolated database
// and compares the database state before and after with the state reader tests/conformance/check/state.mts.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { endGroup } from './check/step.mts';
import { runCase, type CaseBody } from '../tests/testcase.mts';
import { errorMessage } from '../tests/errors.mts';

/**
 * step runs one case, which ends when its processes end; no clock ends it (T473). A failed case is reported with its reason
 * and the check ends there.
 */
export async function step(name: string, body: CaseBody): Promise<void> {
  if (!(await runCase(name, body))) process.exit(1);
}

/**
 * run starts program as the leader of its own process group and returns its standard output when it has ended.
 */
export function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(program, args, { env, detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    function finish(error: Error | null): void {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(stdout);
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.on('error', finish);
    // child is the leader of its own group. A process left in that group after it ends is treated as a failure (endGroup).
    const ended = new Promise<string[]>(resolve => child.on('exit', () => endGroup(child.pid).then(resolve, (error: unknown) => resolve([`its group could not be checked: ${errorMessage(error)}`]))));
    child.on('close', async code => {
      const left = await ended;
      finish(left.length ? new Error(`${program} left ${left.length} processes: ${left.join(', ')}`)
        : code === 0 ? null : new Error(`${program} exit ${code}: ${stderr || stdout}`));
    });
  });
}

/** state is the hash of the database state that the state reader reports; the DSN never appears in an error. */
export async function state(database: string, dsn: string): Promise<string> {
  let output = '';
  let redacted: string | undefined;
  try { output = await run(process.execPath, [join(import.meta.dirname, '../tests/conformance/check/state.mts'), '--driver', database, '--dsn', dsn]); }
  catch (error) { redacted = errorMessage(error).replaceAll(dsn, '[redacted]'); }
  if (redacted !== undefined) throw new Error(redacted);
  const match = new RegExp(`^${database} state ([a-f0-9]{64})\\n$`).exec(output);
  if (!match?.[1]) throw new Error(`${database}: invalid state reader output`);
  return match[1];
}
