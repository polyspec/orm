// Runs the TypeScript model, dbspec runtime, schema set, add columns, clock, driver error and rollback integration tests on
// SQLite, MySQL and PostgreSQL, the SQLite locking test and the MySQL TLS test; ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN
// name test databases, and ORM_TEST_MYSQL_TLS_* the TLS server of make test-servers. The tests do not read one another's
// results, so a failed test does not stop the next, and the script lists every failed test at the end.
import { resolve } from 'node:path';
import { keepAll, render, run, type Command } from '../check/commands.mts';

const root = resolve(import.meta.dirname, '../..');
// The build reports no case of its own, so it runs as a long operation through tests/run-long.mts with no deadline; its
// output and exit code are STEP lines. The tests read the build, so a failed build stops the script.
const BUILD: Command = { program: 'node', args: ['tests/run-long.mts', 'typescript-build', '--', 'npm', 'run', 'typescript:build'], cwd: root };
const node = (...args: string[]): Command => ({ program: 'node', args, cwd: root });
const TESTS: Command[] = [
  node('packages/ts/tests/model.mjs'),
  node('--test', 'packages/ts/tests/dbspec_runtime_db.mjs'),
  node('packages/ts/tests/sqlite-concurrency.mjs'),
  node('packages/ts/tests/schema-set.mjs'),
  node('packages/ts/tests/add-tables-and-columns.mjs'),
  node('packages/ts/tests/clock.mjs'),
  node('packages/ts/tests/driver-error.mjs'),
  node('--conditions=orm-test', 'packages/ts/tests/rollback.mjs'),
  node('--conditions=orm-test', 'packages/ts/tests/statement_fault.mjs'),
  node('--conditions=orm-test', 'packages/ts/tests/statement_fault_entry.mjs'),
  node('packages/ts/tests/mysql_tls.mjs'),
];
/** The commands this script runs, for make repo-check. */
export const COMMANDS = [BUILD, ...TESTS].map(step => render(step, root));

/** sqliteTest runs the build and then the tests, and resolves with the failed tests. */
export async function sqliteTest(write?: (line: string) => void): Promise<string[]> {
  const built = await run(BUILD, write);
  if (built !== 0) return [`${render(BUILD)} (exit ${built}), so no test ran`];
  return keepAll(TESTS, write);
}

if (import.meta.main) {
  const failed = await sqliteTest();
  if (failed.length) {
    console.error(`sqlite-test: failed:${failed.map(line => `\n  ${line}`).join('')}`);
    process.exit(1);
  }
}
