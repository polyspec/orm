// errorCode and errorMessage read a caught value, which may be anything a throw gave: the code of a Node system error
// (ENOENT, ESRCH, ...) and the message of an Error, narrowed by instanceof and in, never by a type assertion.

/** errorCode is the code of a Node system error, or undefined for any other value. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** errorMessage is the message of an Error, or the text of any other value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The exit of a child process that execFile rejected: its exit code (or signal) and its output. */
export type ExecFailure = { code: number | string | undefined; killed: boolean; stdout: string; stderr: string };

/** execFailure reads the rejection of promisify(execFile): the code and the output it carries, narrowed by in. */
export function execFailure(error: unknown): ExecFailure {
  if (!(error instanceof Error)) throw error;
  const code = 'code' in error && (typeof error.code === 'number' || typeof error.code === 'string') ? error.code : undefined;
  const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  const killed = 'killed' in error && error.killed === true;
  return { code, killed, stdout, stderr };
}
