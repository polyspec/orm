// go run is split into two steps, build and run. go run compiles the program before running it, and that compile prints nothing
// and is a long-running task. So first run `go build -o <temp file> <package>` as the long task `go-build/<name>`
// (runLong, no deadline, compiler output and exit code as STEP lines), then run the program with the arguments received.
// The program's output is passed through as-is and ends with its exit code. The temp file is removed at the end.
//
// Usage: node tests/go-run.mts <name> <package> [args...]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLong, stepLines } from './testcase.mts';

const [name, pkg, ...args] = process.argv.slice(2);
if (!name || !pkg) {
  console.error('usage: node tests/go-run.mts <name> <package> [args...]');
  process.exit(2);
}
const directory = mkdtempSync(join(tmpdir(), 'orm-go-run-'));
const program = join(directory, name.replaceAll('/', '_'));
try {
  const built = await runLong(`go-build/${name}`, ({ step }) => new Promise<void>((resolve, reject) => {
    const child = spawn('go', ['build', '-o', program, pkg], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = stepLines(step);
    child.stdout.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      lines.flush();
      if (code === 0) { step('exit 0'); resolve(); } else reject(new Error(`go build exited with ${code}`));
    });
  }));
  if (!built) process.exitCode = 1;
  else {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(program, args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (status, signal) => resolve(status ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
