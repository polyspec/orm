// The suite of one runtime: every test file of the runtime in contracts/implementations.json (its test globs, less its support
// files and its internal tests), each file run as its own process, as the test runner of the runtime runs one file. A file that
// another check runs with arguments of its own is left to that check, and OWNED_ELSEWHERE names it with that check.
//
// Usage: node scripts/suite-test.mts <php|typescript|python> [--list]
//   --list prints the commands and runs none.
// Each file runs from the checkout root with the environment of the make target (the servers and databases of TEST_ENV,
// FLOWMARK, ORM_PYTHON). ORM_SUITE_LANES (default 4) is the number of files that run at the same time; a case of a database
// test makes a database of its own (FCV-9), so files do not share state.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, run, variable, type Command } from './check/commands.mts';
import { implementationFiles, implementationTestInventory } from './features/languages.mts';
import { performanceTest } from './features/performance-reference.mts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const SUITE_LANES = ['php', 'typescript', 'python'] as const;
export type SuiteLane = (typeof SUITE_LANES)[number];
const isLane = (name: string): name is SuiteLane => SUITE_LANES.some(lane => lane === name);

const DATABASES = ['mysql', 'postgres', 'sqlite'] as const;

/**
 * OWNED_ELSEWHERE are the test files that another check runs with arguments of its own, each with that check's source, which
 * names the file: the measurements of PERF-1 (scripts/features/performance-reference.mts, make feature-performance-check), the
 * decimal round trip on each database (scripts/decimal-physical-check.mts, --dialect) and the markdown conformance cases
 * against the flowmark server (make markdown-conformance-check/<runtime>).
 */
export const OWNED_ELSEWHERE: Record<string, string> = {
  ...Object.fromEntries((['php', 'typescript', 'python'] as const).flatMap(runtime =>
    DATABASES.map(database => [performanceTest(runtime, database).test, 'scripts/features/performance-reference.mts']))),
  'packages/php/tests/DecimalModelDbTest.php': 'scripts/decimal-physical-check.mts',
  'packages/ts/tests/decimal_model_db.mjs': 'scripts/decimal-physical-check.mts',
  'packages/python/tests/decimal_model_db.py': 'scripts/decimal-physical-check.mts',
  'packages/php/tests/MarkdownConformanceTest.php': 'Makefile',
  'packages/ts/tests/markdown_conformance.mjs': 'Makefile',
  'packages/python/tests/markdown_conformance.py': 'Makefile',
};

/** suiteTests is the test files of `lane` that its suite runs, in byte order. */
export function suiteTests(lane: SuiteLane, tests: Record<string, string[]> = implementationTestInventory(implementationFiles(root)).tests): string[] {
  const files = tests[lane];
  if (files === undefined) throw new Error(`suite-test: contracts/implementations.json declares no implementation ${lane}`);
  return files.filter(file => !Object.hasOwn(OWNED_ELSEWHERE, file)).sort();
}

/** suiteCommand is the process that runs one test file of `lane`, from the checkout root. */
export function suiteCommand(lane: SuiteLane, test: string): Command {
  switch (lane) {
    case 'php':
      return { program: 'php', args: ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', test], cwd: root, env: { ORM_PHP_MODE: 'library' } };
    case 'typescript':
      return { program: 'node', args: ['--conditions=orm-test', '--test', test], cwd: root };
    case 'python':
      // A module of the tests runs under unittest, which fails a module that holds no test (exit 5) rather than passing it.
      return { program: variable('ORM_PYTHON'), args: ['-m', 'unittest', '-v', test.replace(/\.py$/, '').replaceAll('/', '.')], cwd: root };
  }
}

/** runSuite runs the files of `lane`, `lanes` at a time, and returns the commands that failed. */
async function runSuite(lane: SuiteLane, lanes: number): Promise<string[]> {
  const commands = suiteTests(lane).map(test => suiteCommand(lane, test));
  const failed: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < commands.length) {
      const command = commands[next++];
      if (command === undefined) return;
      const shown = render(command, root);
      const lines: string[] = [];
      const code = await run(command, line => lines.push(line));
      // The output of a file is written together, after the file ends, so that files that run at the same time do not interleave.
      console.log(`== ${shown} (exit ${code})`);
      for (const line of lines) console.log(line);
      if (code !== 0) failed.push(`${shown} (exit ${code})`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, commands.length) }, worker));
  return failed;
}

if (import.meta.main) {
  const [lane, flag] = process.argv.slice(2);
  if (lane === undefined || !isLane(lane) || (flag !== undefined && flag !== '--list')) {
    console.error(`usage: node scripts/suite-test.mts <${SUITE_LANES.join('|')}> [--list]`);
    process.exit(2);
  }
  if (flag === '--list') {
    for (const test of suiteTests(lane)) console.log(render(suiteCommand(lane, test), root));
  } else {
    const lanes = Number(process.env['ORM_SUITE_LANES'] ?? 4);
    if (!Number.isInteger(lanes) || lanes < 1) {
      console.error('suite-test: ORM_SUITE_LANES must be a positive integer');
      process.exit(2);
    }
    const failed = await runSuite(lane, lanes);
    if (failed.length) {
      console.error(`suite-test: ${failed.length} of the ${lane} files failed:${failed.map(line => `\n  ${line}`).join('')}`);
      process.exit(1);
    }
    console.log(`suite-test: every ${lane} file passed`);
  }
}
