// Hot-path gates against the seeded bench databases named by ORM_BENCH_MYSQL_DSN, BENCH_MYSQL_DSN, BENCH_POSTGRES_DSN and
// BENCH_SQLITE_DSN; each gate fails by the name of its variable when it is unset. The seven measurements (five Go gates, and the
// PHP gate without and under CPU load) are independent: a failed one does not stop the rest, and the script lists every failed
// measurement and ends with 1.
import { resolve } from 'node:path';
import { keepAll, render, type Command } from './check/commands.mts';

const root = resolve(import.meta.dirname, '..');
const phpunit = (env?: Record<string, string>): Command => ({
  program: 'php', args: ['vendor-php/bin/phpunit', '--configuration', 'legacy/packages/php/phpunit.xml.dist', 'legacy/packages/php/tests/PerfGateTest.php'], cwd: root, env: { ORM_PERF_REFUSED_LOADED: '', ...env },
});
const STEPS: Command[] = [
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', './legacy/packages/go/bench', '-run', '^TestNative', '-count=1'], cwd: root },
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', './legacy/packages/go/bench', '-run', '^TestHotPathGate(UnderLoad)?$', '-count=1'], cwd: root },
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', './legacy/packages/go/bench', '-run', '^TestPerformanceMeasurementMysql$', '-count=1'], cwd: root },
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', './legacy/packages/go/bench', '-run', '^TestPerformanceMeasurementPostgres$', '-count=1'], cwd: root },
  { program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', './legacy/packages/go/bench', '-run', '^TestPerformanceMeasurementSQLite$', '-count=1'], cwd: root },
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
