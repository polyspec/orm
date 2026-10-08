// Running commands. `execute` returns the outcome of a command, `run` returns its output and fails with a Stop when it does
// not end with an accepted status, and `git.mjs` runs git through them.
import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 256 * 1024 * 1024;

/** A step of a tool fails; the message names the cause. */
export class Stop extends Error {}

/** Runs a command to its end in `cwd` with `env`; returns `{ status, stdout, stderr, error }` with the output as text. */
export const execute = (command, args, { cwd, env } = {}) => spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: MAX_BUFFER });

/** The standard output of a command; Stop with the command, its exit status and its standard error when the status is not in `statuses`. */
export function run(command, args, { cwd, env, statuses = [0] } = {}) {
  const result = execute(command, args, { cwd, env });
  if (result.error) throw new Stop(`${[command, ...args].join(' ')} could not start: ${result.error.message}`);
  if (!statuses.includes(result.status)) throw new Stop(`${[command, ...args].join(' ')} exited with ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
