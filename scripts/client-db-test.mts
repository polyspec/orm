// Runs the database tests of every client on SQLite, MySQL and PostgreSQL. ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name
// the test servers (each case creates its own database there), ORM_TEST_MYSQL_SERVER_DSN and ORM_TEST_POSTGRES_SERVER_DSN
// name the same servers without a pooler, and ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name dedicated databases for
// the Rust catalog connection tests; a test fails when one it needs is unset. ORM_CLIENT_DB_LANGS selects clients (default:
// all). ORM_PYTHON names the Python of the venv that make orm-install-python builds. The rollback fault cases run through each client's test entry point: the Go build tag ormtest, which tests/go-test.mts gives every Go run, the Rust feature
// test-faults and the Node condition orm-test.
//
// With ORM_CLIENT_DB_LANES=parallel the clients run together, one lane each. Each case creates and uses its own database,
// so lanes that overlap use no database together. A line of a lane carries the prefix [<client>], and the script ends with
// 1 after every lane when one failed. The run through the poolers (client-pooler-check) runs the clients in turn, since the
// poolers limit their server connections (ProxySQL 4, PgBouncer 4 per database).
//
// Rust builds and runs the workspace tests once with ORM_RUST_TEST_FEATURES (Makefile: test-faults and live-db); the
// rollback fault cases and the live-db cases of orm-build are in that run.
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepAll, render, run, runLanes, variable, type Command } from './check/commands.mts';
import { COMMANDS as TYPESCRIPT_COMMANDS, sqliteTest } from './typescript/sqlite-test.mts';
import { implementationLanguages } from './features/languages.mts';
import { readFeatures, type FeatureManifest, type NativeCommand } from './features/manifest.mts';

const root = resolve(import.meta.dirname, '..');
// The lanes are the declared implementations of config/parity.json, the one language set.
const LANES = implementationLanguages();
const isLane = (name: string): boolean => LANES.includes(name);
const env = (name: string): string => process.env[name] ?? '';

const go = (...args: string[]): Command => ({ program: 'node', args: ['tests/go-test.mts', '-v', '-timeout', '0', '-count=1', ...args], cwd: root });
// tests/go-test.mts gives the run the tag ormtest, so the rollback and statement fault tests run in it.
const GO: Command[] = [go('./packages/go/...')];
const PHP_TESTS = ['ModelTest', 'AesJsonTest', 'RuntimeDbTest', 'AuditExternalSetsTest', 'SqliteConcurrencyTest', 'SchemaSetTest', 'AddTablesAndColumnsTest',
  'ClockTest', 'DriverErrorTest', 'RollbackTest', 'StatementFaultTest', 'RequestHookTest', 'MysqlTlsTest'];
const PHP: Command[] = PHP_TESTS.map(test => ({ program: 'php', args: ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', `packages/php/tests/${test}.php`], cwd: root }));
// The php-extension lane builds the extension into the directory of its run, as a long operation through tests/run-long.mts, and runs
// the PHP database test files of the php lane with that build loaded, through kit's run-tests in extension mode (S10 of
// PRINCIPLES.md): the library's own autoload is not loaded, so each test exercises the extension.
const PHP_EXTENSION_RUN = join(root, `.runtime/run/client-db-php-extension-${process.pid}`);
const PHP_EXTENSION_LIBRARY = join(PHP_EXTENSION_RUN, 'php-extension/polyspec_orm.so');
const KIT_RUN_TESTS = fileURLToPath(import.meta.resolve('@polyspec/kit/run-tests'));
const PHP_EXTENSION_BUILD: Command = { program: 'node', args: ['tests/run-long.mts', 'php-extension-build', '--', 'sh', 'packages/php-ext/scripts/build.sh', PHP_EXTENSION_LIBRARY], cwd: root };
// Each file is one run, and each test keeps the time limit of its PHPUnit size (phpunit.xml.dist), which kit's run-tests applies
// when no --timeout is given.
const PHP_EXTENSION: Command[] = PHP_TESTS.map(test => ({
  program: 'node',
  args: [KIT_RUN_TESTS, 'phpunit', '--php-extension', PHP_EXTENSION_LIBRARY, '--', '--configuration', 'packages/php/phpunit.xml.dist', `packages/php/tests/${test}.php`],
  cwd: root,
  env: { ORM_PHP_MODE: 'extension' },
}));
// The Python database tests run as modules of packages.python.tests with the Python of the venv (ORM_PYTHON).
const PYTHON_TESTS = ['mysql_session', 'statement_fault', 'identity_load', 'schema_inspection', 'statement_events', 'install_changed_database', 'mysql_tls', 'connection_config', 'replica', 'connection_utc', 'connection_pool', 'aes_rotation'];
const PYTHON: Command[] = PYTHON_TESTS.map(test => ({ program: variable('ORM_PYTHON'), args: ['-m', `packages.python.tests.${test}`], cwd: root }));
/** Returns the exact Rust symbols that the database feature matrix owns, for the generic client test run to skip. */
export function rustDatabaseCoverageSkipArguments(manifest: FeatureManifest, repository: string): string[] {
  const testSymbols = new Set<string>();
  const rustCommands: { feature: string; command: NativeCommand }[] = [];
  for (const feature of manifest.features) {
    const coverage = feature.coverage;
    if (coverage?.kind !== 'database') continue;
    const parts = [coverage.owners.rust, ...coverage.dependents.filter(part => part.language === 'rust')].filter(part => part !== undefined);
    for (const part of parts) {
      for (const commands of Object.values(part.commands)) {
        for (const command of commands ?? []) if (command.runner === 'cargo') rustCommands.push({ feature: feature.id, command });
      }
    }
  }
  for (const { feature, command } of rustCommands) {
    for (const id of command.cases) {
      const symbol = command.symbols?.[id];
      if (typeof symbol !== 'string' || symbol === '') throw new Error(`${feature}: Rust case ${id} has no declared native test symbol`);
      testSymbols.add(symbol);
    }
  }

  // The integration harness also includes the top-level catalog test file under a module name. Discover that alias
  // from its Rust module declaration so the workspace run excludes both compiled copies of the same declared test.
  const integrationRoot = resolve(repository, 'packages/rust/tests/tests/integration/main.rs');
  const integrationDirectory = dirname(integrationRoot);
  const integrationSource = readFileSync(integrationRoot, 'utf8');
  const declaration = /(?:#\[path\s*=\s*"([^"]+)"\]\s*)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  for (const match of integrationSource.matchAll(declaration)) {
    const [, explicitPath, name] = match;
    if (name === undefined) continue;
    const moduleFile = explicitPath === undefined ? resolve(integrationDirectory, `${name}.rs`) : resolve(integrationDirectory, explicitPath);
    const declared = rustCommands.filter(({ command }) => resolve(repository, command.test) === moduleFile);
    for (const { command } of declared) {
      const standaloneTarget = !command.test.replaceAll('\\', '/').includes('/integration/');
      for (const id of command.cases) {
        const symbol = command.symbols?.[id];
        if (typeof symbol !== 'string' || symbol === '') throw new Error(`Rust case ${id} in ${command.test} has no declared native test symbol`);
        if (symbol.startsWith(`${name}::`)) {
          testSymbols.add(symbol);
          if (standaloneTarget) testSymbols.add(symbol.slice(name.length + 2));
        } else {
          testSymbols.add(`${name}::${symbol}`);
        }
      }
    }
  }
  return [...testSymbols].sort().flatMap(symbol => ['--skip', symbol]);
}

// tests/cargo-test.mts builds the test binaries under the lease of the shared target directory as a long operation with no
// deadline, copies them into the directory of one run and runs the copies.
const RUST_TESTS: Command = {
  program: 'node',
  args: [
    '../../tests/cargo-test.mts', 'workspace-tests', '--', 'cargo', 'test', '--locked', '--workspace', '--features', variable('ORM_RUST_TEST_FEATURES'), '--',
    ...rustDatabaseCoverageSkipArguments(readFeatures(root), root), '--exact',
  ],
  cwd: join(root, 'packages/rust'),
  env: { ORM_BUILD_TEST_ROOT: resolve(root, 'packages/rust/build') },
};
/** The commands this script runs, for make repo-check. */
export const COMMANDS = [...[...GO, ...PHP, PHP_EXTENSION_BUILD, ...PHP_EXTENSION, ...PYTHON, RUST_TESTS].map(step => render(step, root)), ...TYPESCRIPT_COMMANDS];

const lanes: Record<string, (write: (line: string) => void) => Promise<string[]>> = {
  go: write => keepAll(GO, write),
  php: write => keepAll(PHP, write),
  'php-extension': async write => {
    try {
      // The tests run only when the build passes; a failed build is a failure of the lane.
      const built = await run(PHP_EXTENSION_BUILD, write);
      if (built !== 0) return [`the build of the PHP extension (exit ${built}), so its tests did not run`];
      return await keepAll(PHP_EXTENSION, write);
    } finally {
      rmSync(PHP_EXTENSION_RUN, { recursive: true, force: true });
    }
  },
  typescript: write => sqliteTest(write),
  python: write => keepAll(PYTHON, write),
  rust: write => keepAll([RUST_TESTS], write),
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
    console.error(`client-db-test: ORM_CLIENT_DB_LANGS names ${unknown}, which is no lane; the lanes are ${LANES.join(', ')}`);
    process.exit(2);
  }
  const selected = LANES.filter(lane => names.includes(lane));
  if (selected.length === 0) {
    console.error(`client-db-test: ORM_CLIENT_DB_LANGS=${env('ORM_CLIENT_DB_LANGS')} selects no lane; the lanes are ${LANES.join(', ')}`);
    process.exit(2);
  }
  // A client of config/parity.json without a lane here is a failure, not a lane that silently does not run.
  const runs = Object.fromEntries(selected.map(lane => {
    const run = lanes[lane];
    if (!run) throw new Error(`client-db-test: the client ${lane} of config/parity.json has no lane`);
    return [lane, run];
  }));
  const failed = await runLanes('client-db-test', runs, process.env['ORM_CLIENT_DB_LANES'] === 'parallel');
  if (failed.length) {
    console.error(`client-db-test: failed lanes: ${failed.join(' ')}`);
    process.exit(1);
  }
  console.log(`client-db-test: every lane passed: ${selected.join(' ')}`);
}
