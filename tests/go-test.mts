// go test is split into build and run steps. go test compiles the package and test binary before running tests, and that
// compile does not report cases. So first, with the same package, build tags, and build flags, run
// `go test -run '^$' -count=1`, which runs no tests, as the long task `go-build/<packages>`
// without a deadline (runLong: compiler output and exit code as STEP lines) to fill the build cache, then run `go test`
// with the received arguments as-is. Test cases in the run step get their own deadlines via packages/go/testcase.
// The run step runs `go test -json` (test2json) and passes the Output of its events through as human-readable output.
// A run that selects tests with `-run` fails if no test was run (no `"Action":"run"` event): a misspelled
// pattern runs nothing and still exits 0, so unless treated as failure, it passes without testing anything. The count
// is taken from test2json events, not from human-readable output. A run that says it selects no tests (`-run '^$'`) is not counted.
//
// Usage: node tests/go-test.mts <go test arguments...>
import { spawn } from 'node:child_process';
import { runLong, stepLines, type Step } from './testcase.mts';
import { parseGoTestEvent } from '../scripts/json/formats.mts';

// Flags that only set the run are removed from the build step. A flag that takes a separate value also removes the next argument.
const runFlags = new Set(['-v', '-run', '-count', '-timeout', '-fuzz', '-fuzztime', '-bench', '-benchtime', '-json', '-failfast', '-short', '-shuffle', '-parallel', '-cpu']);
const valued = new Set(['-run', '-count', '-timeout', '-fuzz', '-fuzztime', '-bench', '-benchtime', '-shuffle', '-parallel', '-cpu']);

// buildArguments are the build step's arguments: the go test arguments with the run flags removed.
export function buildArguments(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    const flag = arg.split('=')[0] ?? '';
    if (runFlags.has(flag)) {
      if (valued.has(flag) && !arg.includes('=')) index++;
      continue;
    }
    out.push(arg);
  }
  return [...out, '-run', '^$', '-count=1'];
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

// go runs `go test <args>` and returns the exit code (or its signal name if it ended by signal). If there is a step (build step), it emits output
// lines as STEP. If not (run step), it adds `-json`, passes the Output of test2json events through to standard
// output, passes through non-JSON lines (such as build errors) too, and returns the count of `"Action":"run"` events as runs.
// The command stays in this process's process group, so terminal interrupts reach it too.
/** The end of one go test: its exit code or the signal that ended it, and the number of tests that ran. */
type GoResult = { code: number | NodeJS.Signals | null; runs: number };

function go(args: string[], step?: Step): Promise<GoResult> {
  return new Promise<GoResult>((resolve, reject) => {
    const child = spawn('go', ['test', ...(step ? [] : ['-json']), ...args], { stdio: step ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'] });
    const lines = step ? stepLines(step) : null;
    // -json in the test arguments asks for the raw test2json stream on standard output (the parity reader of kit reads it).
    const events = step ? null : testEvents(undefined, args.includes('-json'));
    child.stdout?.on('data', (chunk: Buffer) => (lines ?? events)?.write(String(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => lines?.write(String(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      lines?.flush();
      events?.flush();
      resolve({ code: code ?? signal, runs: events?.runs() ?? 0 });
    });
  });
}

// testEvents reads test2json output line by line. Event Output (test output and build output) goes to standard output, and non-JSON lines
// are passed through, and `run` events with a Test are counted.
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

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node tests/go-test.mts <go test arguments...>');
    process.exit(2);
  }
  const pattern = selection(args);
  const built = await runLong(`go-build/${packages(args)}`, async ({ step }) => {
    const { code } = await go(buildArguments(args), step);
    if (code !== 0) throw new Error(`go test build exited with ${code}`);
    step('exit 0');
  });
  if (!built) process.exit(1);
  const { code, runs } = await go(args);
  if (code === 0 && pattern !== undefined && pattern !== '^$' && runs === 0) {
    console.error(`go-test: -run ${pattern} selected no test in ${packages(args)}`);
    process.exit(1);
  }
  process.exit(typeof code === 'number' ? code : 1);
}
