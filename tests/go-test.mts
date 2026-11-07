// Compile repository Go test binaries once, then execute those outputs through Go's native event converter.
// The build never runs TestMain. Package and case failures do not suppress independent packages.
// Usage: node tests/go-test.mts [--dry-run] <repository go test arguments...>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runLong, stepLines, type Step } from './testcase.mts';
import { parseGoTestEvent } from '../scripts/json/formats.mts';
import { goBatches, goCompileArguments, goDiscoveryArguments, goExecuteArguments, goInvocation, goPackages } from './go-native.mts';

// GO_TEST_TAGS are the build tags of every go test of the repository: ormtest builds the test entry point (protocol §3) and
// the tests that arm it, which a run without the tag would leave out unseen. Each run takes them here, so no target repeats them.
export const GO_TEST_TAGS = ['ormtest'];

// withTestTags are the arguments with GO_TEST_TAGS merged into their -tags flag, in either flag form, or put first when
// there is none. Two -tags flags are refused: go keeps only the last, so one of them would be dropped unseen.
export function withTestTags(args: string[]): string[] {
  const at = args.flatMap((arg, index) => (arg === '-tags' || arg.startsWith('-tags=') ? [index] : []));
  if (at.length > 1) throw new Error(`go-test: more than one -tags flag in ${args.join(' ')}`);
  const index = at[0];
  if (index === undefined) return ['-tags', GO_TEST_TAGS.join(','), ...args];
  const inline = args[index]?.startsWith('-tags=') ?? false;
  const given = (inline ? args[index]?.slice('-tags='.length) : args[index + 1]) ?? '';
  const tags = [...new Set([...given.split(',').filter(Boolean), ...GO_TEST_TAGS])].join(',');
  const out = [...args];
  if (inline) out[index] = `-tags=${tags}`;
  else out[index + 1] = tags;
  return out;
}

// packages are the package patterns among the arguments (starting with ./). They become the build case's name.
export function packages(args: string[]): string {
  return args.filter(arg => arg.startsWith('./')).map(arg => arg.slice(2)).join(',') || '.';
}

// selection is the `-run` pattern among the arguments. It is undefined if there is none.
export function selection(args: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === '-run') return args[index + 1];
    if (arg.startsWith('-run=')) return arg.slice('-run='.length);
  }
  return undefined;
}

/** Preview the same native phases without discovering packages or starting Go. */
export function goDryRun(given: string[]) {
  const plan = goInvocation(withTestTags(given));
  return { mode: 'dry-run', execution: 'not-run', commands: [
    { phase: 'discover', program: 'go', args: goDiscoveryArguments(plan) },
    { phase: 'build', program: 'go', args: ['test', '-c', ...plan.build, '-o', '<owned build directory>', '<discovered compatible packages>'], requires: 'package discovery succeeded' },
    { phase: 'test', program: 'go', args: ['tool', 'test2json', '-t', '-p', '<discovered package>', '<owned binary>', ...plan.native], requires: 'this package build succeeded', cwd: '<discovered package directory>' },
  ], cleanup: 'remove the owned run directory after execution' };
}

function go(args: string[], options: { cwd?: string; raw?: boolean; step?: Step; capture?: boolean } = {}): Promise<{ code: number; runs: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('go', args, { ...(options.cwd ? { cwd: options.cwd } : {}), stdio: ['inherit', 'pipe', 'pipe'] });
    const lines = options.step ? stepLines(options.step) : null;
    const events = options.step ? null : testEvents(undefined, options.raw);
    let stdout = '';
    let readError: string | undefined;
    const read = (work: () => void) => {
      if (readError) return;
      try { work(); }
      catch (error) {
        readError = error instanceof Error ? error.message : String(error);
        console.error(`go-test: invalid native event stream: ${readError}; inspect go tool test2json output`);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.capture) stdout += String(chunk);
      read(() => (lines ?? events)?.write(String(chunk)));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (lines) lines.write(String(chunk));
      else process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      lines?.flush();
      read(() => events?.flush());
      if (signal) console.error(`go-test: go ${args.join(' ')} ended by ${signal}; inspect the runner process report`);
      resolve({ code: readError ? 1 : code ?? 1, runs: events?.runs() ?? 0, stdout });
    });
  });
}

// testEvents reads test2json output line by line. Event Output (test output and build output) goes to standard output, and non-JSON lines
// are passed through, and completed pass/fail events with a Test are counted.
export function testEvents(write: (text: string) => unknown = (text: string) => process.stdout.write(text), raw = false): { write(chunk: string): void; flush(): void; runs: () => number } {
  let partial = '';
  let runs = 0;
  const line = (text: string): void => {
    // test2json writes one JSON line per event. Lines not starting with `{` are text go wrote outside events, so they are passed through as-is.
    if (!text.startsWith('{')) {
      write(`${text}\n`);
      return;
    }
    const event = parseGoTestEvent(text, 'go test -json');
    // A case is a test event with a result: pass or fail (run is only the start of a case, and go test omits it without -v).
    if ((event.Action === 'pass' || event.Action === 'fail') && event.Test) runs++;
    if (raw) {
      write(`${text}\n`);
      return;
    }
    // Passes through the Output of output events and build events (build-output; since Go 1.24, -json also emits build output as events).
    if (event.Output !== undefined) write(event.Output);
  };
  return {
    write(chunk: string): void {
      const all = (partial + chunk).split('\n');
      partial = all.pop() ?? '';
      for (const text of all) line(text);
    },
    flush(): void {
      if (partial) line(partial);
      partial = '';
    },
    runs: () => runs,
  };
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const dryRun = raw[0] === '--dry-run';
  const given = dryRun ? raw.slice(1) : raw;
  if (given.length === 0) throw new Error('usage: node tests/go-test.mts [--dry-run] <repository go test arguments...>');
  if (dryRun) { console.log(JSON.stringify(goDryRun(given), null, 2)); return; }
  const args = withTestTags(given);
  const plan = goInvocation(args);
  const pattern = selection(args);
  const parent = resolve(new URL('..', import.meta.url).pathname, '.runtime/run');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, `go-test-${process.env.ORM_STEP ?? 'direct'}-${process.pid}-`));
  let failed = false;
  let runs = 0;
  try {
    let output = '';
    const discovered = await runLong(`go-packages/${packages(args)}`, async ({ step }) => {
      const command = goDiscoveryArguments(plan);
      step(JSON.stringify(['go', ...command]));
      const result = await go(command, { step, capture: true });
      if (result.code !== 0) throw new Error(`go list exited with ${result.code}`);
      output = result.stdout;
    });
    if (!discovered) { process.exitCode = 1; return; }
    const discoveredPackages = goPackages(output);
    const ready: { pkg: typeof discoveredPackages[number]; binary: string }[] = [];
    for (const batch of goBatches(discoveredPackages, directory)) {
      mkdirSync(batch.directory);
      const built = await runLong(`go-build/${batch.entries.map(entry => entry.pkg.path).join(',')}`, async ({ step }) => {
        const command = goCompileArguments(plan, batch.entries.map(entry => entry.pkg), batch.directory);
        step(JSON.stringify(['go', ...command]));
        const result = await go(command, { step });
        if (result.code !== 0) throw new Error(`go test -c exited with ${result.code}; inspect each package's compiler output`);
        step('exit 0');
      });
      if (!built) failed = true;
      for (const { pkg, binary } of batch.entries) {
        if (!pkg.directory) {
          console.error(`go-test: go list provided no directory for ${pkg.path}; provide a package in the checkout`);
          failed = true;
        } else if (pkg.hasTests && existsSync(binary)) ready.push({ pkg, binary });
        else if (pkg.hasTests) {
          console.error(`go-test: no compiled test binary for ${pkg.path}; inspect its compiler output`);
          failed = true;
        } else console.log(`? ${pkg.path} [no test files]`);
      }
    }
    for (const { pkg, binary } of ready) {
      const command = goExecuteArguments(plan, pkg, binary);
      console.log(`[go-test] run ${JSON.stringify({ program: 'go', args: command, cwd: pkg.directory })}`);
      const result = await go(command, { cwd: pkg.directory, raw: plan.raw });
      console.log(`[go-test] ${pkg.path}: exit ${result.code}, ${result.runs} completed cases`);
      if (result.code !== 0) failed = true;
      runs += result.runs;
    }
    if (!failed && pattern !== undefined && pattern !== '^$' && runs === 0) {
      console.error(`go-test: -run ${pattern} selected no test in ${plan.packages.join(',')}`);
      failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
