// cargo test runs not in the shared Rust target directory (CARGO_TARGET_DIR, which concurrent runs of this checkout write together) but
// in a single copy. cargo test runs the test binary it built from the target directory, so if another run builds again between the build and the run,
// the other run's binary is executed instead.
//
//   1. build: run `cargo test --no-run --message-format=json-render-diagnostics` with the same arguments as a long-running task
//      `rust-build/<name>` (runLong, no deadline, compiler output as STEP), and copy the test binary cargo reported
//      into the run directory. The build and the copy take the target directory's exclusive lease (LEASE, CARGO_LEASES, --wait)
//      inside one process, so no other build can come in between.
//      Also copy the program of the package the test runs; the test receives its path as ORM_PROGRAM_<NAME>.
//   2. run: run the copy like cargo test, from the package directory with CARGO_MANIFEST_DIR, with the test name filter and `--`
//      arguments after it, one at a time. Each test case has its own deadline and RUN, PASS, FAIL lines. Even after a failed binary,
//      the rest still run (same as cargo test --no-fail-fast), all failed binaries are listed, and it ends with the first failure's exit code.
//
// All Rust doc code in this repository is ```text, so there are no doctests to run and doctests are not run.
//
// Usage: node tests/cargo-test.mts <name> -- cargo [+<toolchain>] test <cargo options and filters> [-- <test binary args>]
//        node tests/cargo-test.mts --copy <run dir> -- <cargo test --no-run command>
//            (Runs under the lease: builds, copies the test binary and dep-info to <run dir>, and records them in binaries.json.
//             Also used by scripts/features/coverage.mts.)
import { spawn, spawnSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runLong, stepLines, type Step } from './testcase.mts';
import { parseCargoMessage } from '../scripts/json/formats.mts';
import { readJsonFile } from '../scripts/json/schema.mts';

/** binaries.json of a --copy run: the copied test binaries and the copied package programs by name. */
export type Binaries = { tests: { executable: string; manifestDir: string; target: string; copy: string }[]; programs: Record<string, string> };

/** readBinaries reads binaries.json of a --copy run directory against its schema (scripts/schema/binaries.schema.json). */
export function readBinaries(runDir: string): Binaries {
  return readJsonFile<Binaries>(join(runDir, 'binaries.json'), new URL('../scripts/schema/binaries.schema.json', import.meta.url).pathname);
}

/** A compiler artifact that cargo reports in its JSON messages. */
type Artifact = { executable: string; test: boolean; manifestPath: string | undefined; name: string | undefined; kinds: string[] };

/** artifact reads one JSON message line of cargo: a compiler artifact with an executable, or undefined for any other line. */
function artifact(line: string): Artifact | undefined {
  if (!line.startsWith('{')) return undefined;
  const message = parseCargoMessage(line, 'cargo --message-format=json');
  if (message.reason !== 'compiler-artifact' || typeof message.executable !== 'string') return undefined;
  return {
    executable: message.executable,
    test: message.profile?.test === true,
    manifestPath: message.manifest_path,
    name: message.target?.name,
    kinds: message.target?.kind ?? [],
  };
}

// valued is a cargo test option that takes its value separately. The next argument is not a test name filter.
const valued = new Set(['--manifest-path', '--features', '-F', '-p', '--package', '--test', '--bin', '--example', '--bench', '--exclude',
  '--target', '--target-dir', '--profile', '-j', '--jobs', '--color', '--message-format', '--config', '-Z']);

// split divides the cargo command into the program prefix (cargo and toolchain), cargo test options, test name filters, and binary arguments.
export function split(command: string[]): { cargo: string[]; options: string[]; filters: string[]; binaryArgs: string[] } {
  const testIndex = command.indexOf('test');
  if (command[0] !== 'cargo' || testIndex < 1 || command.slice(1, testIndex).some(arg => !arg.startsWith('+')))
    throw new Error(`not a cargo test command: ${command.join(' ')}`);
  const rest = command.slice(testIndex + 1);
  const separator = rest.indexOf('--');
  const before = separator === -1 ? rest : rest.slice(0, separator);
  const binaryArgs = separator === -1 ? [] : rest.slice(separator + 1);
  const options: string[] = [];
  const filters: string[] = [];
  for (let index = 0; index < before.length; index++) {
    const arg = before[index] ?? '';
    if (arg === '--no-run') throw new Error('cargo-test.mts builds with --no-run itself');
    if (arg.startsWith('-')) {
      options.push(arg);
      if (valued.has(arg) && !arg.includes('=')) options.push(before[++index] ?? '');
    } else filters.push(arg);
  }
  return { cargo: command.slice(0, testIndex), options, filters, binaryArgs };
}

// executables reads the test binary and its package directory from cargo's JSON messages.
export function executables(stdout: string): { executable: string; manifestDir: string; target: string }[] {
  const out: { executable: string; manifestDir: string; target: string }[] = [];
  for (const line of stdout.split('\n')) {
    const found = artifact(line);
    if (!found?.test) continue;
    if (found.manifestPath === undefined) throw new Error(`cargo reported the test binary ${found.executable} without its manifest_path`);
    out.push({ executable: found.executable, manifestDir: dirname(found.manifestPath), target: found.name ?? basename(found.executable) });
  }
  return out;
}

// programs reads, as name and executable file, the package programs cargo built along with the tests (`[[bin]]`, not test targets).
// The test receives that path as ORM_PROGRAM_<NAME> (polyspec_orm_testcase::program).
export function programs(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const found = artifact(line);
    if (found && !found.test && found.name !== undefined && found.kinds.includes('bin')) out[found.name] = found.executable;
  }
  return out;
}

// programEnvironment is the ORM_PROGRAM_<NAME> variable, one per copied program, that the test reads.
export function programEnvironment(copies: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(copies).map(([name, path]) => [`ORM_PROGRAM_${name.toUpperCase().replaceAll('-', '_')}`, path]));
}

/** The end of a child process: its exit code, the signal that ended it, and its standard output. */
type Ended = { code: number; signal: NodeJS.Signals | null; stdout: string };

function run(program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, step?: Step): Promise<Ended> {
  return new Promise<Ended>((finish, fail) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', step ? 'pipe' : 'inherit', step ? 'pipe' : 'inherit'] });
    const lines = step ? stepLines(step) : null;
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => lines?.write(String(chunk)));
    child.on('error', fail);
    child.on('close', (code, signal) => { lines?.flush(); finish({ code: code ?? 128, signal, stdout }); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--copy') {
    // --copy <run dir> -- <cargo build command>: builds under the lease and copies the test binary.
    const [, runDir, separator, program, ...build] = args;
    if (separator !== '--' || runDir === undefined || program === undefined) throw new Error('usage: cargo-test.mts --copy <run dir> -- <cargo command>');
    const child = spawn(program, build, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    const code = await new Promise<number>(finish => child.on('close', status => finish(status ?? 1)));
    if (code !== 0) process.exit(code);
    const copies = executables(stdout).map((binary, index) => {
      const copy = join(runDir, `${index}-${basename(binary.executable)}`);
      // The copy first tries a copy-on-write clone (APFS clonefile, Linux reflink) so it uses almost no disk. Where that does not work,
      // on the file system it is usually a plain copy.
      copyFileSync(binary.executable, copy, constants.COPYFILE_FICLONE);
      // Also copy the dep-info (<binary>.d) that rustc writes beside the binary. Feature coverage uses it to read the source files
      // that the binary was compiled from.
      if (existsSync(`${binary.executable}.d`)) copyFileSync(`${binary.executable}.d`, `${copy}.d`, constants.COPYFILE_FICLONE);
      console.error(`cargo-test: ${binary.executable} copied to ${copy}`);
      return { ...binary, copy };
    });
    // Also copy the program of the package the test runs, within the same lease.
    const programCopies: Record<string, string> = {};
    for (const [name, executable] of Object.entries(programs(stdout))) {
      mkdirSync(join(runDir, 'programs'), { recursive: true });
      const copy = join(runDir, 'programs', name);
      copyFileSync(executable, copy, constants.COPYFILE_FICLONE);
      console.error(`cargo-test: ${executable} copied to ${copy}`);
      programCopies[name] = copy;
    }
    writeFileSync(join(runDir, 'binaries.json'), JSON.stringify({ tests: copies, programs: programCopies }, null, 1) + '\n');
    return;
  }
  const separator = args.indexOf('--');
  if (separator !== 1) throw new Error('usage: node tests/cargo-test.mts <name> -- cargo [+<toolchain>] test ...');
  const name = args[0] ?? '';
  const { cargo, options, filters, binaryArgs } = split(args.slice(2));
  const { LEASE: lease, CARGO_LEASES: leases } = process.env;
  if (!lease || !leases) throw new Error('LEASE and CARGO_LEASES are unset; run this through make, which exports them');
  // The run directory goes in the checkout's .runtime/run: test binary copies are large, and CI's /tmp is a memory-backed
  // tmpfs. The name carries the step (ORM_STEP, given by the check runner and owner-check), so even if this process ends by a signal and never runs its finally,
  // the runner finds and removes it when the step ends.
  const runs = resolve(new URL('..', import.meta.url).pathname, '.runtime/run');
  mkdirSync(runs, { recursive: true });
  const runDir = mkdtempSync(join(runs, `cargo-test-${process.env.ORM_STEP ?? 'direct'}-${process.pid}-`));
  try {
    let built = false;
    const passed = await runLong(`rust-build/${name}`, async ({ step }) => {
      const result = await run(lease, ['run', leases, 'exclusive', '--wait', '--', process.execPath, new URL(import.meta.url).pathname, '--copy', runDir, '--',
        ...cargo, 'test', '--no-run', '--message-format=json-render-diagnostics', ...options], {}, step);
      if (result.code !== 0) throw new Error(`cargo test --no-run exited with ${result.code}`);
      step('exit 0');
      built = true;
    });
    if (!passed || !built) {
      process.exitCode = 1;
      return;
    }
    const { tests: binaries, programs: programCopies } = readBinaries(runDir);
    if (binaries.length === 0) throw new Error(`cargo test --no-run ${options.join(' ')} built no test binary`);
    // Before running, count the tests each binary's filter selects with `--list`. If the total is 0, a misspelled filter
    // would end every binary with 0 without running anything, so it fails without running.
    let selected = 0;
    for (const binary of binaries) {
      const listed = spawnSync(binary.copy, ['--list', ...filters, ...binaryArgs], { cwd: binary.manifestDir, encoding: 'utf8', env: { ...process.env, ...programEnvironment(programCopies), CARGO_MANIFEST_DIR: binary.manifestDir } });
      if (listed.status !== 0) throw new Error(`${binary.copy} --list exited with ${listed.status ?? listed.signal}: ${listed.stderr || listed.stdout}`);
      selected += listed.stdout.split('\n').filter(line => line.endsWith(': test')).length;
    }
    if (selected === 0) {
      console.log(`cargo-test: the filters ${filters.join(' ') || '(none)'} select no test in ${binaries.length} test binaries`);
      process.exitCode = 1;
      return;
    }
    console.log(`cargo-test: ${selected} tests selected in ${binaries.length} test binaries`);
    // Even after a failed binary, run the remaining binaries (same as cargo test --no-fail-fast). At the end, list all failed binaries.
    const failed: { target: string; code: number; signal: NodeJS.Signals | null }[] = [];
    for (const binary of binaries) {
      console.log(`cargo-test: running ${binary.target} (${binary.copy})`);
      const result = await run(binary.copy, [...filters, ...binaryArgs], { cwd: binary.manifestDir, env: { ...process.env, ...programEnvironment(programCopies), CARGO_MANIFEST_DIR: binary.manifestDir } });
      if (result.code !== 0) {
        console.log(`cargo-test: ${binary.target} exited with ${result.signal ?? result.code}`);
        failed.push({ target: binary.target, code: result.code, signal: result.signal });
      }
    }
    if (failed.length) {
      console.log(`cargo-test: ${failed.length} of ${binaries.length} test binaries failed: ${failed.map(({ target, code, signal }) => `${target} (${signal ?? `exit ${code}`})`).join(', ')}`);
      process.exitCode = failed[0]?.code || 1;
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await main();
