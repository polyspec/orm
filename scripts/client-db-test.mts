// Runs the database tests of every client on SQLite, MySQL and PostgreSQL. ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name
// the test servers (each case creates its own database there), ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN
// name the same servers without a pooler, and ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name dedicated databases for
// the Rust catalog connection tests; a test fails when one it needs is unset. ORM_CLIENT_DB_LANGS selects clients (default:
// all). ORM_PYTHON names the Python of the venv that make install-python builds. The rollback fault cases run through each client's test entry point: the Go build tag ormtest, the Rust feature
// test-faults and the Node condition orm-test.
//
// With ORM_CLIENT_DB_LANES=parallel the clients run together, one lane each. Each case creates and uses its own database,
// so lanes that overlap use no database together. A line of a lane carries the prefix [<client>], and the script ends with
// 1 after every lane when one failed. The run through the poolers (client-pooler-check) runs the clients in turn, since the
// poolers limit their server connections (ProxySQL 4, PgBouncer 4 per database).
//
// Rust builds and runs the workspace tests once with ORM_RUST_TEST_FEATURES (Makefile: test-faults and live-db); the
// rollback fault cases and the live-db cases of orm-build are in that run.
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { keepAll, render, run, runLanes, variable, type Command } from './check/commands.mts';
import { COMMANDS as TYPESCRIPT_COMMANDS, sqliteTest } from './typescript/sqlite-test.mts';

const root = resolve(import.meta.dirname, '..');
const LANES = ['go', 'php', 'typescript', 'rust', 'python'] as const;
type Lane = (typeof LANES)[number];
const isLane = (name: string): name is Lane => LANES.some(lane => lane === name);
const env = (name: string): string => process.env[name] ?? '';

const go = (...args: string[]): Command => ({ program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', '-count=1', ...args], cwd: root });
const GO: Command[] = [go('./packages/go/...'), go('-tags', 'ormtest', '-run', '^Test(RollbackFault|StatementFault)', './packages/go/orm')];
const PHP_TESTS = ['ModelTest', 'AesJsonTest', 'RuntimeDbTest', 'AuditExternalSetsTest', 'SqliteConcurrencyTest', 'SchemaSetTest', 'AddTablesAndColumnsTest',
  'ClockTest', 'DriverErrorTest', 'RollbackTest', 'StatementFaultTest', 'RequestHookTest', 'MysqlTlsTest'];
const PHP: Command[] = PHP_TESTS.map(test => ({ program: 'php', args: ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', `packages/php/tests/${test}.php`], cwd: root }));
// The Python database tests run as modules of packages.python.tests with the Python of the venv (ORM_PYTHON).
const PYTHON_TESTS = ['mysql_session', 'statement_fault', 'identity_load', 'schema_inspection', 'statement_events', 'install_changed_database', 'mysql_tls', 'connection_config', 'replica', 'connection_utc', 'connection_pool'];
const PYTHON: Command[] = PYTHON_TESTS.map(test => ({ program: variable('ORM_PYTHON'), args: ['-m', `packages.python.tests.${test}`], cwd: root }));
// tests/cargo-test.mts builds the test binaries under the lease of the shared target directory as a long operation with no
// deadline, copies them into the directory of one run and runs the copies.
const RUST_TESTS: Command = { program: 'node', args: ['../../tests/cargo-test.mts', 'workspace-tests', '--', 'cargo', 'test', '--locked', '--workspace', '--features', variable('ORM_RUST_TEST_FEATURES')], cwd: join(root, 'packages/rust') };
// The integration program is built under the lease of the shared Rust target directory and copied into the directory of
// this run (scripts/cargo-build-copy.mts), which runs the copy; the build reports no case, so it runs through
// tests/run-long.mts with no deadline.
const RUN = join(root, `.runtime/run/client-db-rust-${process.pid}`);
const RUST_BUILD: Command = {
  program: 'node', args: ['tests/run-long.mts', 'rust-build/integration', '--cwd', 'packages/rust', '--', variable('LEASE'), 'run', variable('CARGO_LEASES'), 'exclusive', '--wait', '--',
    'node', join(root, 'scripts/cargo-build-copy.mts'), RUN, 'debug/integration', '--', 'cargo', 'build', '--locked', '-p', 'polyspec-orm-tests', '--bin', 'integration'], cwd: root,
};
const RUST_INTEGRATION: Command = { program: join(RUN, 'debug/integration'), args: [join(root, 'contracts/fixtures/bench/bench.dbs')], cwd: root };
/** The commands this script runs, for make repo-check. */
export const COMMANDS = [...[...GO, ...PHP, ...PYTHON, RUST_TESTS, RUST_BUILD, RUST_INTEGRATION].map(step => render(step, root)), ...TYPESCRIPT_COMMANDS];

const lanes: Record<Lane, (write: (line: string) => void) => Promise<string[]>> = {
  go: write => keepAll(GO, write),
  php: write => keepAll(PHP, write),
  typescript: write => sqliteTest(write),
  python: write => keepAll(PYTHON, write),
  rust: async write => {
    const failed = await keepAll([RUST_TESTS], write);
    try {
      // The integration program runs only when its build passes; a failed build is a failure of the lane.
      const built = await run(RUST_BUILD, write);
      if (built !== 0) failed.push(`the build of the integration program (exit ${built}), so the integration program did not run`);
      else failed.push(...await keepAll([RUST_INTEGRATION], write));
    } finally {
      rmSync(RUN, { recursive: true, force: true });
    }
    return failed;
  },
};

if (import.meta.main) {
  if (!process.env['ORM_RUST_TEST_FEATURES']) {
    console.error('ORM_RUST_TEST_FEATURES is required; run through make');
    process.exit(2);
  }
  process.env['PATH'] = `${join(homedir(), '.cargo/bin')}${delimiter}${process.env['PATH'] ?? ''}`;
  // Every name of ORM_CLIENT_DB_LANGS is a lane, and it selects at least one: a misspelled name would end in success
  // without running its lane.
  const names = (process.env['ORM_CLIENT_DB_LANGS'] || LANES.join(',')).split(',').filter(name => name !== '');
  const unknown = names.find(name => !isLane(name));
  if (unknown !== undefined) {
    console.error(`client-db-test: ORM_CLIENT_DB_LANGS names ${unknown}, which is no lane; the lanes are go, php, typescript, rust and python`);
    process.exit(2);
  }
  const selected = LANES.filter(lane => names.includes(lane));
  if (selected.length === 0) {
    console.error(`client-db-test: ORM_CLIENT_DB_LANGS=${env('ORM_CLIENT_DB_LANGS')} selects no lane; the lanes are go, php, typescript, rust and python`);
    process.exit(2);
  }
  const failed = await runLanes('client-db-test', Object.fromEntries(selected.map(lane => [lane, lanes[lane]])), process.env['ORM_CLIENT_DB_LANES'] === 'parallel');
  if (failed.length) {
    console.error(`client-db-test: failed lanes: ${failed.join(' ')}`);
    process.exit(1);
  }
  console.log(`client-db-test: every lane passed: ${selected.join(' ')}`);
}
