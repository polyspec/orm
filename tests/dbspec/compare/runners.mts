// Six dbspec compare runners. The Go, PHP, TypeScript, Python, Rust, and PHP extension runners all read <cases.json> <stress document>
// <ddl.json> <plans.json> <mermaid.json> <syntax.json> (reads). Each runner follows the
// line format of tests/dbspec/compare/check.mts, and if an input cannot be read or a vector is missing or of another type, it writes to stderr an error stating the location
// error and exits nonzero. The TypeScript runner requires the TypeScript build, and the Rust runner requires dbspec_compare
// example's debug build, and the PHP extension runner requires the polyspec_orm extension (POLYSPEC_ORM_EXTENSION) that make built.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargoTarget } from '../../cargo-target.mts';

export const root = fileURLToPath(new URL('../../../', import.meta.url));

// INPUTS is the name and order of the inputs that runRunner receives.
export const INPUTS = ['cases', 'stress', 'ddl', 'plans', 'mermaid', 'syntax'];

// phpExtension is the path of the polyspec_orm extension that make dbspec-compare-check built into that run's directory.
function phpExtension() {
  const path = process.env.POLYSPEC_ORM_EXTENSION;
  if (!path) throw new Error('POLYSPEC_ORM_EXTENSION names no build of the PHP extension polyspec_orm; run make dbspec-compare-check, which builds it and sets it');
  return path;
}

// pythonCommand is the interpreter with the Python client's dependencies (cryptography, PyYAML) installed. make dbspec-compare-check
// gives ORM_PYTHON the interpreter of packages/python/.venv that make orm-install-python created.
function pythonCommand() {
  const path = process.env.ORM_PYTHON;
  if (!path) throw new Error('ORM_PYTHON names no Python interpreter with the client dependencies; run make orm-install-python, which creates packages/python/.venv, and run make dbspec-compare-check, which sets ORM_PYTHON');
  return path;
}

export const runners: (Runner & { reads: string[] })[] = [
  { name: 'go', command: 'go', args: ['run', './packages/go/internal/dbspec/compare'], reads: INPUTS },
  { name: 'php', command: 'php', args: ['packages/php/testing/dbspec/compare/php.php'], reads: INPUTS },
  { name: 'typescript', command: process.execPath, args: ['packages/ts/testing/dbspec/compare/typescript.mts'], reads: INPUTS },
  {
    name: 'python',
    get command() {
      return pythonCommand();
    },
    args: ['-m', 'tests.dbspec.compare.python'],
    reads: INPUTS,
  },
  { name: 'rust', command: join(cargoTarget(), 'debug/examples/dbspec_compare'), args: [], reads: INPUTS },
  {
    name: 'php-extension',
    command: 'php',
    get args() {
      return ['-d', `extension=${phpExtension()}`, 'packages/php-ext/testing/dbspec/compare/php-extension.php'];
    },
    reads: INPUTS,
  },
];

// runRunner returns the runner's exit code or signal, stdout, and stderr, and rejects only when the process cannot be started.
// For compare runners that declare reads, it gives the inputs (paths in INPUTS order) that the runner reads; for runners without reads,
// it gives the inputs as they are (the apply runner and stress harness of tests/dbspec/inputs.test.mts).
/** A runner: its program and arguments, and for a compare runner the inputs it reads, by name. */
export type Runner = { name: string; readonly command: string; readonly args: string[]; reads?: string[] };
/** The end of a runner: its exit code or signal and its output. */
export type RunnerResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

export function runRunner(runner: Runner, inputs: string[], timeout: number): Promise<RunnerResult> {
  const reads = runner.reads;
  if (reads && inputs.length !== INPUTS.length) throw new Error(`runRunner gives a compare runner the ${INPUTS.length} inputs ${INPUTS.join(', ')}; given ${inputs.length}; pass all six, and the runner takes those its reads names`);
  const args = reads ? reads.map(name => inputs[INPUTS.indexOf(name)] ?? '') : inputs;
  return new Promise<RunnerResult>((resolve, reject) => {
    const child = spawn(runner.command, [...runner.args, ...args], { cwd: root, timeout });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}
