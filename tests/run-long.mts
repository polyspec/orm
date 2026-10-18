// Runs one long task (build, install, tsc, go generate, go vet, cargo build, cargo test --no-run, a format or
// lint tool run) with no deadline. Starts from runLong in tests/testcase.mts
// (`RUN <name> no-deadline`), prints command output lines (with elapsed time), the exit code (STEP `exit 0`), and
// the result (PASS, or FAIL with the exit code or signal). So that a slow but normal task does not fail because of the clock,
// there is no deadline and no no-output deadline, and it takes no deadline argument. Success and failure are decided by
// the exit code and the errors printed. The command runs in the same process group as this process, so terminal
// interrupts reach it too.
//
// Usage: node tests/run-long.mts <name> [--cwd <dir>] -- <program> [args...]
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { runLong, stepLines } from './testcase.mts';

function usage(): never {
  console.error('usage: node tests/run-long.mts <name> [--cwd <dir>] -- <program> [args...]');
  process.exit(2);
}

// parseArgs reads --cwd before the separator and takes every argument after `--` as a positional, so the program and its
// arguments reach spawn unchanged.
let parsed: ReturnType<typeof parseArgs<{ options: { cwd: { type: 'string' } }; allowPositionals: true }>>;
try {
  parsed = parseArgs({ options: { cwd: { type: 'string' } }, allowPositionals: true });
} catch {
  usage();
}
const separator = process.argv.indexOf('--', 2);
const [name, program, ...programArgs] = parsed.positionals;
if (separator < 0 || name === undefined || program === undefined || parsed.positionals.length - 1 !== process.argv.length - separator - 1) usage();
const cwd = parsed.values.cwd ?? process.cwd();

const passed = await runLong(name, ({ step }) => new Promise<void>((resolve, reject) => {
  const child = spawn(program, programArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = stepLines(step);
  child.stdout.on('data', (chunk: Buffer) => lines.write(String(chunk)));
  child.stderr.on('data', (chunk: Buffer) => lines.write(String(chunk)));
  child.on('error', reject);
  child.on('close', (code, signal) => {
    lines.flush();
    if (code === 0) {
      step('exit 0');
      resolve();
    } else reject(new Error(code === null ? `${program} ended by ${signal}` : `${program} exited with ${code}`));
  });
}));
process.exit(passed ? 0 : 1);
