// Hot-path gates against the seeded MySQL bench database named by ORM_BENCH_MYSQL_DSN; each gate fails when the variable
// is unset. The four measurements are independent: a failed one does not stop the rest, and the script lists every failed
// measurement and ends with 1.
import { resolve } from 'node:path';
import { keepAll, render, type Command } from './check/commands.mts';

const root = resolve(import.meta.dirname, '..');
const phpunit = (env?: Record<string, string>): Command => ({
  program: 'php', args: ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', 'packages/php/tests/PerfGateTest.php'], cwd: root, ...(env ? { env } : {}),
});
const STEPS: Command[] = [
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', './packages/go/bench', '-run', '^TestNative', '-count=1'], cwd: root },
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', '-tags', 'perfgate', './packages/go/bench', '-run', '^TestHotPathGate(UnderLoad)?$', '-count=1'], cwd: root },
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', '-tags', 'featurecoverage', './packages/go/bench', '-run', '^TestCoveragePerformanceGate$', '-count=1'], cwd: root },
  phpunit(),
  phpunit({ ORM_PERF_CPU_LOAD: '1' }),
];
/** The commands this script runs, for make repo-check. */
export const COMMANDS = STEPS.map(step => render(step, root));

if (import.meta.main) {
  const failed = await keepAll(STEPS);
  if (failed.length) {
    console.error(`perf-test: failed:${failed.map(line => `\n  ${line}`).join('')}`);
    process.exit(1);
  }
}
