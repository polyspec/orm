// typescript-lease decides which TypeScript lease a verify command holds, and runs the command under it. The TypeScript build
// output (legacy/packages/ts/dist and the generated models) is rebuilt in place, so a command that reads it holds the shared lease of
// READ_TYPESCRIPT, and a command that builds it holds the exclusive lease of HOLD_TYPESCRIPT (Makefile). A reader never runs
// while a build runs, and readers run together. The lease program divides the holding of the ancestor (make owner-check) for
// its children by the same rule, so a command under that holding is not refused by its own run.
import { spawn } from 'node:child_process';

export type TypeScriptLease = 'shared' | 'exclusive';

/** The lease of a check: exclusive for a build of the TypeScript output or a make target that holds it, shared for a command that
 *  reads legacy/packages/ts (in its command or its declared inputs), and none for any other command. */
export function typescriptLease(check: { command: string; inputs?: string[] }): TypeScriptLease | undefined {
  if (/typescript:build|\bmake\b/.test(check.command)) return 'exclusive';
  if (check.command.includes('legacy/packages/ts') || (check.inputs ?? []).some(input => input.startsWith('legacy/packages/ts/'))) return 'shared';
  return undefined;
}

/** The lease program and its directory, read from the variables that make exports (LEASE, TYPESCRIPT_LEASES). */
export function typescriptLeaseProgram(env: NodeJS.ProcessEnv): { program: string; directory: string } {
  const program = env.LEASE;
  const directory = env.TYPESCRIPT_LEASES;
  if (!program || !directory) throw new Error('LEASE and TYPESCRIPT_LEASES are unset; run make feature-verify-other, which exports them');
  return { program, directory };
}

/** runCommand runs command with /bin/sh in cwd, under lease when it is given: `lease run <dir> <mode> --wait -- sh -c command`. */
export function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  lease: { program: string; directory: string; mode: TypeScriptLease } | undefined,
  output: (chunk: string) => void,
): Promise<{ code: number; output?: string }> {
  return new Promise(resolveRun => {
    const child = lease
      ? spawn(lease.program, ['run', lease.directory, lease.mode, '--wait', '--', '/bin/sh', '-c', command], { cwd, env })
      : spawn('/bin/sh', ['-c', command], { cwd, env });
    child.stdout.on('data', (chunk: Buffer) => output(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => output(String(chunk)));
    child.on('error', error => resolveRun({ code: 1, output: error.message }));
    child.on('close', code => resolveRun({ code: code ?? 1 }));
  });
}
