// Counts the test cases that a test run reports, through the event readers of kit (@polyspec/kit/test-output), and fails
// when it reports none: a run that executes no case passes nothing, so it must not pass. The input is the output of the
// run on standard input; the runner names its format: go (go test -json), node (node --test), cargo (cargo test),
// python (unittest -v), phpunit (phpunit --teamcity). Exit 0 with the count printed; exit 1 when the count is zero;
// exit 2 for a bad argument. A run that fails a case is not this tool's concern: its own exit status reports that.
import { cargoEvents, goEvents, nodeEvents, phpunitEvents, pythonEvents, type Sink } from '@polyspec/kit/test-output';

const READERS = ['go', 'node', 'cargo', 'python', 'phpunit'] as const;
export type Reader = (typeof READERS)[number];

/**
 * A sink that counts the cases that pass or fail. kit reports a package or suite result with the same id and name, and a case
 * with its path in the id (`pkg › TestName`), so only a reference whose id differs from its name is a case. A skipped or todo
 * case is not one that ran.
 */
export function countingSink(): { sink: Sink; cases: () => number } {
  let cases = 0;
  const isCase = (test: { id: string; name: string }) => test.id !== test.name;
  const sink: Sink = {
    start: () => undefined,
    pass: test => { if (isCase(test)) cases++; },
    fail: test => { if (isCase(test)) cases++; },
    skip: () => undefined,
    todo: () => undefined,
    line: () => undefined,
    raw: () => undefined,
  };
  return { sink, cases: () => cases };
}

/** Feeds the whole output of a run through the reader of its format and returns the number of cases it reports. */
export function countCases(reader: Reader, output: string): number {
  const { sink, cases } = countingSink();
  if (reader === 'cargo') {
    const reading = cargoEvents(sink);
    reading.stdout(output);
  } else if (reader === 'python') {
    pythonEvents(sink)(output);
  } else {
    const feed = reader === 'go' ? goEvents(sink) : reader === 'node' ? nodeEvents(sink) : phpunitEvents(sink);
    for (const line of output.split('\n')) if (line.trim() !== '') feed(line);
  }
  return cases();
}

async function main(argv: string[]): Promise<number> {
  const reader = argv[0];
  if (!READERS.includes(reader as Reader)) {
    console.error(`count-cases: the reader must be one of ${READERS.join(', ')}, got ${JSON.stringify(reader)}`);
    return 2;
  }
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  const count = countCases(reader as Reader, chunks.join(''));
  console.log(`count-cases: ${count} ${reader} cases reported`);
  if (count === 0) {
    console.error(`count-cases: the ${reader} run reported zero cases; a run that executes no case must not pass`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
