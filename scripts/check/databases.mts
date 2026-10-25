// The databases of one run (make orm-check, make owner-check, make run-databases): created for the run and dropped at its end.
// No bench, decimal, or complex-query fixture database is shared: one that another run or session uses and changes would make the results depend
// on it, so each run creates, seeds and drops its own databases. The environment file of the
// servers names no such database; it gives the DSNs to rename (ORM_RUN_*).
//
//   databases.mts create <servers env> <directory> <name> [--complex-query]
//   databases.mts drop <servers env> <directory> <name>
//   databases.mts drop-dead <servers env> <directory> <name>
//
// create makes, on the servers of <servers env> (the file that make orm-test-servers writes), the MySQL and PostgreSQL databases
// <name>_bench and <name>_decimal and the SQLite files of <directory>; with --complex-query, which a run passes only when one of its
// targets or owner parts reads them, also the 18 owner-specific complex-query fixture databases (12 MySQL/PostgreSQL databases and
// 6 SQLite files) with their COMPLEX_QUERY_*_DSN. It installs and seeds them from their canonical fixtures, and writes <directory>/env
// (<servers env> with the BENCH_*, ORM_BENCH_MYSQL_DSN and the send-savepoint SQLite file ORM_SEND_SQLITE_DSN of this run) and
// <directory>/decimal-env. create first drops the databases
// that ended runs left (drop-dead). drop drops them and purges the binary logs of the two MySQL servers up to what the
// replica applied (purgeBinlogs); drop is the last step of a run and runs even when an earlier step failed, so the binary
// logs that the run wrote leave with the run. <name> is lowercase letters, digits and underscores.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, type Command } from './commands.mts';
import { errorCode, errorMessage } from '../../tests/errors.mts';

const root = resolve(import.meta.dirname, '../..');
const USAGE = 'usage: databases.mts create <servers env> <directory> <name> [--complex-query] | databases.mts drop|drop-dead <servers env> <directory> <name>';

/** environmentFile is the variables of an environment file that orm-test-servers and this script write: export NAME='value' lines. */
export function environmentFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').filter((line: string) => line.trim() !== '')) {
    const match = /^export ([A-Z_][A-Z0-9_]*)='([^']*)'$/.exec(line);
    if (!match) throw new Error(`unexpected environment line: ${line}`);
    out[match[1] ?? ''] = match[2] ?? '';
  }
  return out;
}

/** withDatabase is the DSN with its database (path) replaced; the scheme, the account, the host and the query stay. */
export function withDatabase(dsn: string, database: string): string {
  const url = new URL(dsn);
  url.pathname = `/${database}`;
  return url.href;
}

/**
 * psqlDsn is a PostgreSQL DSN as psql takes it: the client parameter timezone, which the servers file gives every client
 * connection and psql refuses (invalid URI query parameter), is removed; the account, the host, the database and the other
 * parameters stay. A psql of this script runs with PGTZ=UTC instead.
 */
function psqlDsn(dsn: string): string {
  const url = new URL(dsn);
  url.searchParams.delete('timezone');
  return url.href;
}

const COMPLEX_QUERY_RUNTIMES = ['go', 'php', 'php_extension', 'typescript', 'python', 'rust'] as const;
const COMPLEX_QUERY_DIALECTS = ['mysql', 'postgres', 'sqlite'] as const;
const COMPLEX_QUERY_RUNTIME_CODES: Record<(typeof COMPLEX_QUERY_RUNTIMES)[number], string> = {
  go: 'g', php: 'p', php_extension: 'pe', typescript: 'ts', python: 'py', rust: 'rs',
};
const COMPLEX_QUERY_DIALECT_CODES: Record<(typeof COMPLEX_QUERY_DIALECTS)[number], string> = { mysql: 'm', postgres: 'p', sqlite: 's' };
type ComplexQueryRuntime = (typeof COMPLEX_QUERY_RUNTIMES)[number];
type ComplexQueryDialect = (typeof COMPLEX_QUERY_DIALECTS)[number];
export type ComplexQueryDatabase = {
  runtime: ComplexQueryRuntime;
  dialect: ComplexQueryDialect;
  database: string;
  file: string;
  dsn: string;
  dsnEnv: string;
  /** The DSN that psql seeds a PostgreSQL fixture through (psqlDsn), or null for MySQL and SQLite. */
  psqlDsn: string | null;
};

// complexQueryDsnEnv is the variable that carries the DSN of the fixture database of one owner and dialect.
const complexQueryDsnEnv = (runtime: ComplexQueryRuntime, dialect: ComplexQueryDialect): string => `COMPLEX_QUERY_${runtime.toUpperCase()}_${dialect.toUpperCase()}_DSN`;

/** The 18 COMPLEX_QUERY_*_DSN variables of the fixture databases; a reader of one needs complex-query. */
export const COMPLEX_QUERY_DSN_ENVS: readonly string[] = COMPLEX_QUERY_RUNTIMES.flatMap(runtime => COMPLEX_QUERY_DIALECTS.map(dialect => complexQueryDsnEnv(runtime, dialect)));

/** The run-owned, seeded database of one owner and dialect; coverage reads this exact DSN before and after its case. */
export function complexQueryDatabasePlan(name: string, directory: string, servers: Record<string, string>): ComplexQueryDatabase[] {
  const mysql = servers['ORM_RUN_MYSQL_DSN'] ?? '';
  const postgres = servers['ORM_RUN_POSTGRES_DSN'] ?? '';
  const sqliteQuery = servers['ORM_RUN_SQLITE_QUERY'] ?? '';
  return COMPLEX_QUERY_RUNTIMES.flatMap(runtime => COMPLEX_QUERY_DIALECTS.map(dialect => {
    // The compact suffix keeps even the longest run name below PostgreSQL's 63-byte and MySQL's 64-byte identifier limits.
    const database = `${name}_cq_${COMPLEX_QUERY_RUNTIME_CODES[runtime]}_${COMPLEX_QUERY_DIALECT_CODES[dialect]}`;
    const file = join(directory, 'complex-query', `${runtime}.sqlite`);
    const dsn = dialect === 'mysql' ? withDatabase(mysql, database)
      : dialect === 'postgres' ? withDatabase(postgres, database)
        : `sqlite://${file}?${sqliteQuery}`;
    const dsnEnv = complexQueryDsnEnv(runtime, dialect);
    return { runtime, dialect, database, file, dsn, dsnEnv, psqlDsn: dialect === 'postgres' ? psqlDsn(dsn) : null };
  }));
}

/** Explicit environment names consumed by the six owner parts of complex_query_product_search. */
export function complexQueryDatabaseEnvironment(plan: readonly ComplexQueryDatabase[]): Record<string, string> {
  for (const item of plan) if (!item.dsn) throw new Error(`${item.dsnEnv} is missing; run ${COMPLEX_QUERY_SETUP}`);
  return Object.fromEntries(plan.map(item => [item.dsnEnv, item.dsn]));
}

/** Drops every owner database even after one drop fails; SQLite files are removed independently. */
export function dropComplexQueryFixtures(plan: readonly ComplexQueryDatabase[], operations: {
  mysql: (database: string) => boolean;
  postgres: (database: string) => boolean;
  sqlite: (file: string) => boolean;
}, failure: (item: ComplexQueryDatabase, error?: unknown) => void = () => {}): boolean {
  let succeeded = true;
  for (const item of plan) {
    // A drop that throws fails like a drop that returns false, and its error goes to failure, so the next drop still runs.
    let dropped = false;
    let thrown: unknown;
    try { dropped = operations[item.dialect](item.dialect === 'sqlite' ? item.file : item.database); }
    catch (error) { thrown = error; }
    if (!dropped) {
      succeeded = false;
      failure(item, thrown);
    }
  }
  return succeeded;
}

/** A fixture database setup step, used by the runner's databases/create phase. */
export const COMPLEX_QUERY_SETUP = 'make databases-create COMPLEX_QUERY=1, which provisions the 18 run-owned complex-query fixture databases; a run passes it when a target declares the need complex-query in contracts/check-inputs.json or an owner part reads a COMPLEX_QUERY_*_DSN';

/** The commands of the setup that create runs, for make repo-check. */
const benchSetup: Command = { program: 'node', args: [join(root, 'scripts/bench-db.mts')], cwd: root };
export const COMMANDS = [benchSetup].map(command => render(command, root));

// result runs a program with an environment; it gives the status and the standard output, and passes standard error on.
function result(program: string, args: string[], env: NodeJS.ProcessEnv, input?: string): { status: number; stdout: string } {
  const ran = spawnSync(program, args, { env, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'], ...(input === undefined ? {} : { input }) });
  return { status: ran.status ?? 1, stdout: ran.stdout ?? '' };
}

// mysqlAt runs the mysql client on the server of a DSN, in <database> when one is given; the DSN is never printed. The
// database of a servers DSN (ORM_RUN_MYSQL_DSN) is a name for this script to replace, not a database that exists.
function mysqlAt(dsn: string, args: string[], env: NodeJS.ProcessEnv, database?: string): { status: number; stdout: string } {
  const url = new URL(dsn);
  return result('mysql', ['--no-defaults', '--protocol=TCP', '-h', url.hostname, '-P', url.port, '-u', decodeURIComponent(url.username),
    ...(database ? ['-D', database] : []), ...args], env);
}

// postgresServer is the server URI of a PostgreSQL DSN, with the maintenance database postgres.
const postgresServer = (dsn: string): string => {
  const url = new URL(dsn);
  return `postgres://${url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''}${url.host}/postgres?sslmode=disable`;
};

// deadRuns names, among database names, those that a run of this host left after its process ended (orm_owner_<pid>_<hex>
// of make owner-check, orm_check_<pid>_<hex> of make orm-check), each with its pid. Such a run was killed before its drop. A
// run whose process lives and the names of CI (ci_<id>) are left; the test servers listen on 127.0.0.1 only, so every run
// is a process of this host.
export function deadRuns(names: string[], alive: (pid: number) => boolean): { database: string; pid: number }[] {
  return names.flatMap(database => {
    const match = /^orm_(?:owner|check)_(\d+)_.*_(?:bench|decimal|cq_(?:g|p|pe|ts|py|rs)_(?:m|p))$/.exec(database);
    if (!match) return [];
    const pid = Number(match[1]);
    return alive(pid) ? [] : [{ database, pid }];
  });
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) === 'EPERM'; }
};

// dropDeadRuns drops on MySQL and PostgreSQL the databases that ended runs left, and names each.
function dropDeadRuns(servers: Record<string, string>, env: NodeJS.ProcessEnv): boolean {
  const mysql = servers['ORM_RUN_MYSQL_DSN'] ?? '';
  const shown = mysqlAt(mysql, ['-N', '-e', 'SHOW DATABASES'], env);
  if (shown.status !== 0) return false;
  for (const { database, pid } of deadRuns(shown.stdout.split('\n').filter(Boolean), alive)) {
    if (mysqlAt(mysql, ['-e', `DROP DATABASE IF EXISTS \`${database}\``], env).status !== 0) return false;
    console.log(`databases: dropped the MySQL database ${database} of run pid ${pid}, which no longer runs`);
  }
  const server = postgresServer(servers['ORM_RUN_POSTGRES_DSN'] ?? '');
  const listed = result('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', server, '-c', 'SELECT datname FROM pg_database'], env);
  if (listed.status !== 0) return false;
  for (const { database, pid } of deadRuns(listed.stdout.split('\n').filter(Boolean), alive)) {
    if (result('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', server, '-c', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`], env).status !== 0) return false;
    console.log(`databases: dropped the PostgreSQL database ${database} of run pid ${pid}, which no longer runs`);
  }
  return true;
}

// purgeBinlogs purges the binary logs of the MySQL primary and replica up to the file each writes now. Only the replica
// reads the binary logs of the test servers, so they are purged only after the replica applied the primary up to its
// position now. It is safe for other runs of the shared servers: what is purged the replica applied, and the file in use
// stays. relay_log_purge removes the relay logs the replica applied, so FLUSH RELAY LOGS closes the file in use.
function purgeBinlogs(serversPath: string, servers: Record<string, string>, env: NodeJS.ProcessEnv): boolean {
  const replica = env['ORM_TEST_MYSQL_REPLICA_DSN'];
  if (!replica) {
    console.error(`databases: ${serversPath} names no ORM_TEST_MYSQL_REPLICA_DSN; run make orm-test-servers to rewrite it`);
    return false;
  }
  const primary = servers['ORM_RUN_MYSQL_DSN'] ?? '';
  if (mysqlAt(primary, ['-e', 'FLUSH BINARY LOGS'], env).status !== 0) return false;
  const status = mysqlAt(primary, ['-N', '-e', 'SHOW BINARY LOG STATUS'], env);
  if (status.status !== 0) return false;
  const [file = '', position = ''] = status.stdout.split('\n')[0]?.split('\t') ?? [];
  if (!/^[A-Za-z0-9._-]+$/.test(file)) { console.error(`databases: the primary reported no binary log file: ${status.stdout.trim()}`); return false; }
  if (!/^\d+$/.test(position)) { console.error(`databases: the primary reported no binary log position: ${status.stdout.trim()}`); return false; }
  // SOURCE_POS_WAIT gives the events it applied (0 or more), -1 past its deadline, and NULL when the replica SQL thread stops.
  const waited = mysqlAt(replica, ['-N', '-e', `SELECT IFNULL(SOURCE_POS_WAIT('${file}', ${position}, 120), 'NULL')`], env);
  if (waited.status !== 0) return false;
  const applied = waited.stdout.trim();
  if (applied === '-1' || applied === 'NULL' || applied === '') {
    console.error(`databases: the replica did not apply the primary's binary log up to ${file}:${position} (SOURCE_POS_WAIT returned ${applied || 'nothing'}); the binary logs are kept`);
    return false;
  }
  if (mysqlAt(primary, ['-e', `PURGE BINARY LOGS TO '${file}'`], env).status !== 0) return false;
  if (mysqlAt(replica, ['-e', 'FLUSH BINARY LOGS; FLUSH RELAY LOGS'], env).status !== 0) return false;
  const own = mysqlAt(replica, ['-N', '-e', 'SHOW BINARY LOG STATUS'], env);
  const ownFile = own.stdout.split('\n')[0]?.split('\t')[0] ?? '';
  if (own.status !== 0 || !/^[A-Za-z0-9._-]+$/.test(ownFile)) { console.error('databases: the replica reported no binary log file'); return false; }
  if (mysqlAt(replica, ['-e', `PURGE BINARY LOGS TO '${ownFile}'`], env).status !== 0) return false;
  console.log(`databases: binary logs purged up to ${file} on the primary and ${ownFile} on the replica`);
  return true;
}

// sqliteAmount is the declared type of decimal_case.amount in a SQLite file; it closes the file.
function sqliteAmount(db: import('node:sqlite').DatabaseSync): string {
  try {
    const row = db.prepare("SELECT type FROM pragma_table_info('decimal_case') WHERE name = 'amount'").get();
    return typeof row?.['type'] === 'string' ? row['type'] : '';
  } finally { db.close(); }
}

// createDecimal creates the MySQL and PostgreSQL database <decimal> and the SQLite file decimal-case.sqlite of <directory>,
// installs the manifest of the decimal model generated from contracts/fixtures/decimal_schema.dbs on each (no hand-written
// DDL: the dbspec renderer writes the statements), checks the type of decimal_case.amount, and writes DECIMAL_MYSQL_DSN,
// DECIMAL_POSTGRES_DSN and DECIMAL_SQLITE_DSN to <directory>/decimal-env. The databases are new for this run: one that
// exists already is another run's, and create refuses it.
async function createDecimal(mysqlBench: string, postgresBench: string, decimal: string, directory: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { connect, SCHEMA } = await import('../../packages/ts/dist/models/decimal_fixture/models.js');
  const { DatabaseSync } = await import('node:sqlite');
  const mysql = withDatabase(mysqlBench, decimal);
  const postgres = withDatabase(postgresBench, decimal);
  const sqlite = join(directory, 'decimal-case.sqlite');
  const created = mysqlAt(mysqlBench, ['-e', `CREATE DATABASE \`${decimal}\``], env).status === 0 &&
    result('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', postgresServer(postgresBench), '-c', `CREATE DATABASE "${decimal}"`], env).status === 0;
  if (!created) { console.error(`databases: cannot create the decimal database ${decimal}`); return false; }
  for (const dsn of [mysql, postgres, `sqlite://${sqlite}`]) {
    const db = await connect(dsn);
    try { await db.utils().schema().install(SCHEMA); } finally { await db.close(); }
  }
  const types: [string, string, string][] = [
    ['mysql', mysqlAt(mysql, ['-N', '-e', "SELECT column_type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'decimal_case' AND column_name = 'amount'"], env, decimal).stdout.trim(), 'decimal(13,4)'],
    ['postgres', result('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', psqlDsn(postgres), '-c',
      "SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')' FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'decimal_case' AND column_name = 'amount'"], env).stdout.trim(), 'numeric(13,4)'],
    ['sqlite', sqliteAmount(new DatabaseSync(sqlite, { readOnly: true })), 'DECIMALINT(13,4)'],
  ];
  for (const [dialect, type, expected] of types) {
    if (type !== expected) { console.error(`databases: ${dialect} decimal amount type is '${type}', expected ${expected}`); return false; }
    console.log(`${dialect} decimal_case amount ${type}`);
  }
  writeFileSync(join(directory, 'decimal-env'), [`export DECIMAL_MYSQL_DSN='${mysql}'`, `export DECIMAL_POSTGRES_DSN='${postgres}'`,
    `export DECIMAL_SQLITE_DSN='sqlite://${sqlite}?_pragma=busy_timeout(5000)&timezone=%2B00:00'`, ''].join('\n'), { mode: 0o600 });
  return true;
}

type ComplexQueryScalar = string | number | boolean | null;

type ComplexQueryFixture = {
  schema: string;
  mysql_setup: string[];
  seed_order: string[];
  seed_columns: Record<string, string[]>;
  seed: Record<string, Record<string, ComplexQueryScalar>[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** Reads the canonical fixture only after validating every field used to set up and seed databases. */
export function parseComplexQueryFixture(value: unknown): ComplexQueryFixture {
  if (!isRecord(value) || typeof value.schema !== 'string' || !stringArray(value.mysql_setup) || !stringArray(value.seed_order)
      || !isRecord(value.seed_columns) || !isRecord(value.seed)) {
    throw new Error('complex query fixture has an invalid top-level shape');
  }

  const seedColumns: Record<string, string[]> = {};
  for (const [table, columns] of Object.entries(value.seed_columns)) {
    if (!stringArray(columns)) throw new Error(`complex query fixture has invalid seed columns for ${table}`);
    seedColumns[table] = columns;
  }

  const seed: Record<string, Record<string, ComplexQueryScalar>[]> = {};
  for (const [table, rows] of Object.entries(value.seed)) {
    if (!Array.isArray(rows)) throw new Error(`complex query fixture has invalid seed rows for ${table}`);
    seed[table] = rows.map((row, index) => {
      if (!isRecord(row)) throw new Error(`complex query fixture seed ${table}[${index}] is not an object`);
      const scalarRow: Record<string, ComplexQueryScalar> = {};
      for (const [column, cell] of Object.entries(row)) {
        if (cell === null || typeof cell === 'string' || typeof cell === 'boolean'
            || (typeof cell === 'number' && Number.isFinite(cell))) {
          scalarRow[column] = cell;
        } else {
          throw new Error(`complex query fixture seed ${table}[${index}].${column} is not a supported SQL scalar`);
        }
      }
      return scalarRow;
    });
  }

  return { schema: value.schema, mysql_setup: value.mysql_setup, seed_order: value.seed_order, seed_columns: seedColumns, seed };
}

function sqlIdentifier(name: string, dialect: ComplexQueryDialect): string {
  return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

function sqlLiteral(value: ComplexQueryScalar, dialect: ComplexQueryDialect): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return dialect === 'sqlite' ? (value ? '1' : '0') : (value ? 'TRUE' : 'FALSE');
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('complex query fixture has unsupported SQL scalar');
}

/** Generates seed statements directly from the shared canonical fixture. */
export function complexQuerySeedSql(fixture: ComplexQueryFixture, dialect: ComplexQueryDialect): string {
  const statements: string[] = [];
  for (const table of fixture.seed_order) {
    const columns = fixture.seed_columns[table];
    const rows = fixture.seed[table];
    if (!columns || !rows) throw new Error(`complex query fixture omits seed metadata for ${table}`);
    for (const row of rows) {
      const values = columns.map(column => {
        if (!Object.hasOwn(row, column)) throw new Error(`complex query fixture seed ${table} omits ${column}`);
        const value = row[column];
        if (value === undefined) throw new Error(`complex query fixture seed ${table}.${column} is undefined`);
        return sqlLiteral(value, dialect);
      });
      statements.push(`INSERT INTO ${sqlIdentifier(table, dialect)} (${columns.map(column => sqlIdentifier(column, dialect)).join(', ')}) VALUES (${values.join(', ')})`);
    }
  }
  return statements.join(';\n') + ';\n';
}

function runComplexQuerySql(item: ComplexQueryDatabase, sql: string, env: NodeJS.ProcessEnv): boolean {
  switch (item.dialect) {
    case 'mysql':
      return mysqlAt(item.dsn, ['-D', item.database, '-e', sql], env).status === 0;
    case 'postgres':
      if (item.psqlDsn === null) throw new Error(`${item.dsnEnv}: a PostgreSQL fixture has no psql DSN; complexQueryDatabasePlan gives it one`);
      return result('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', item.psqlDsn, '-c', sql], { ...env, PGTZ: 'UTC' }).status === 0;
    case 'sqlite':
      return result('sqlite3', ['-bail', item.file], env, sql).status === 0;
  }
}

async function createComplexQueryFixtures(name: string, directory: string, servers: Record<string, string>, env: NodeJS.ProcessEnv): Promise<boolean> {
  const plan = complexQueryDatabasePlan(name, resolve(directory), servers);
  mkdirSync(join(directory, 'complex-query'), { recursive: true });
  const mysqlServer = servers['ORM_RUN_MYSQL_DSN'] ?? '';
  const postgresMaintenance = postgresServer(servers['ORM_RUN_POSTGRES_DSN'] ?? '');
  for (const item of plan) {
    if (item.dialect === 'mysql' && mysqlAt(mysqlServer, ['-e', `CREATE DATABASE \`${item.database}\``], env).status !== 0) {
      console.error(`databases: cannot create the complex-query MySQL fixture database ${item.database}`);
      return false;
    }
    if (item.dialect === 'postgres' && result('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', postgresMaintenance, '-c', `CREATE DATABASE "${item.database}"`], env).status !== 0) {
      console.error(`databases: cannot create the complex-query PostgreSQL fixture database ${item.database}`);
      return false;
    }
  }

  const { Db, dbspecManifest, parseDbspec } = await import('../../packages/ts/dist/index.js');
  const fixture = parseComplexQueryFixture(JSON.parse(readFileSync(join(root, 'contracts/fixtures/complex_query/complex_query.json'), 'utf8')));
  const parsed = parseDbspec(readFileSync(join(root, fixture.schema), 'utf8'), {});
  if (parsed.document === null) {
    console.error('databases: contracts/fixtures/complex_query/complex_query.dbs is invalid');
    return false;
  }
  const manifestResult = dbspecManifest([parsed.document]);
  if (manifestResult.manifest === null) {
    console.error('databases: cannot build the complex-query fixture manifest');
    return false;
  }
  const schema = { manifestText: manifestResult.manifest.manifestText, manifestHash: manifestResult.manifest.manifestHash };
  for (const item of plan) {
    let setup;
    try {
      setup = await Db.connectSchema(item.dsn, schema);
      await setup.utils().schema().install(schema);
    } catch (error) {
      console.error(`databases: cannot install the complex-query fixture schema on ${item.runtime}/${item.dialect}: ${errorMessage(error)}`);
      return false;
    } finally {
      if (setup) await setup.close();
    }
    const setupSql = item.dialect === 'mysql' ? `${fixture.mysql_setup.join(';\n')};\n` : '';
    const seedSql = complexQuerySeedSql(fixture, item.dialect);
    const transaction = item.dialect === 'sqlite' ? 'BEGIN IMMEDIATE;\n' : item.dialect === 'postgres' ? 'BEGIN;\n' : 'START TRANSACTION;\n';
    if (!runComplexQuerySql(item, `${setupSql}${transaction}${seedSql}COMMIT;\n`, env)) {
      console.error(`databases: cannot seed the complex-query fixture for ${item.runtime}/${item.dialect}`);
      return false;
    }
  }
  console.log('databases: all 18 owner-specific complex-query fixture databases were installed and seeded');
  return true;
}

if (import.meta.main) {
  const [action, serversPath, dir, name, ...rest] = process.argv.slice(2);
  const complexQuery = action === 'create' && rest.length === 1 && rest[0] === '--complex-query';
  if (action === undefined || serversPath === undefined || dir === undefined || name === undefined || (rest.length > 0 && !complexQuery)) {
    console.error(USAGE);
    process.exit(2);
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    console.error(`databases: invalid name ${name}`);
    process.exit(2);
  }
  if (action !== 'create' && action !== 'drop' && action !== 'drop-dead') {
    console.error(USAGE);
    process.exit(2);
  }
  let servers: Record<string, string>;
  try {
    servers = environmentFile(readFileSync(serversPath, 'utf8'));
  } catch (error) {
    console.error(`databases: ${action}: ${serversPath}: ${errorMessage(error)}; run make orm-test-servers to rewrite it`);
    process.exit(2);
  }
  // The servers file is sourced: its variables are the environment of every command of this run.
  const env: NodeJS.ProcessEnv = { ...process.env, ...servers };
  const needed = action === 'drop'
    ? ['ORM_RUN_MYSQL_DSN', 'ORM_RUN_POSTGRES_DSN', 'ORM_TEST_MYSQL_REPLICA_DSN']
    : action === 'create' || action === 'drop-dead'
      ? ['ORM_RUN_MYSQL_DSN', 'ORM_RUN_POSTGRES_DSN'] : [];
  for (const variable of needed) {
    const value = variable === 'ORM_TEST_MYSQL_REPLICA_DSN' ? env[variable] : servers[variable];
    if (!value) {
      console.error(`databases: ${action}: ${serversPath} names no ${variable}; run make orm-test-servers to rewrite it`);
      process.exit(1);
    }
  }
  const runMysql = servers['ORM_RUN_MYSQL_DSN'] ?? '';
  const mysqlBench = withDatabase(runMysql, `${name}_bench`);
  const postgresBench = withDatabase(servers['ORM_RUN_POSTGRES_DSN'] ?? '', `${name}_bench`);
  const sqliteBench = `sqlite://${dir}/bench.sqlite?${servers['ORM_RUN_SQLITE_QUERY'] ?? ''}`;
  // ORM_BENCH_MYSQL_DSN is the DSN of the same database without its query.
  const ormBench = mysqlBench.replace(/\?.*$/, '');
  switch (action) {
    case 'create': {
      // A killed run cannot drop its databases, so the databases of ended runs are dropped first.
      if (!dropDeadRuns(servers, env)) process.exit(1);
      mkdirSync(dir, { recursive: true });
      const benchEnv = { ...env, BENCH_MYSQL_DSN: mysqlBench, BENCH_POSTGRES_DSN: postgresBench, BENCH_SQLITE_DSN: sqliteBench };
      const bench = spawnSync('node', [join(root, 'scripts/bench-db.mts')], { cwd: root, env: benchEnv, stdio: 'inherit' });
      if (bench.status !== 0) process.exit(bench.status ?? 1);
      if (!await createDecimal(mysqlBench, postgresBench, `${name}_decimal`, resolve(dir), env)) process.exit(1);
      if (complexQuery && !await createComplexQueryFixtures(name, resolve(dir), servers, env)) process.exit(1);
      // Without --complex-query the env names no COMPLEX_QUERY_*_DSN, so a reader of a fixture fails with COMPLEX_QUERY_SETUP.
      const complexQueryEnv = complexQuery ? complexQueryDatabaseEnvironment(complexQueryDatabasePlan(name, resolve(dir), servers)) : {};
      const lines = [readFileSync(serversPath, 'utf8').replace(/\n?$/, '\n'),
        `export ORM_BENCH_MYSQL_DSN='${ormBench}'\n`, `export BENCH_MYSQL_DSN='${mysqlBench}'\n`, `export BENCH_POSTGRES_DSN='${postgresBench}'\n`,
        `export BENCH_SQLITE_DSN='${sqliteBench}'\n`,
        ...Object.entries(complexQueryEnv).map(([key, value]) => `export ${key}='${value}'\n`),
        // The SQLite file of rust-send-savepoint and of the Rust test of client-db-check (tx::send_tests) is of this run too.
        `export ORM_SEND_SQLITE_DSN='sqlite://${dir}/send-savepoint.sqlite'\n`];
      writeFileSync(join(dir, 'env.tmp'), lines.join(''));
      renameSync(join(dir, 'env.tmp'), join(dir, 'env'));
      console.log(`databases: ${name}_bench and ${name}_decimal${complexQuery ? ', and 18 complex-query fixture databases' : ''} created and seeded`);
      break;
    }
    case 'drop': {
      // Dropping the MySQL and PostgreSQL databases, the run folder and the binary logs are independent: a failure does not
      // stop the rest, and every failure is named at the end. A failure names its step only, since the commands hold DSNs.
      const failed: string[] = [];
      const keep = (label: string, done: () => boolean) => { if (!done()) failed.push(`${label} (exit 1)`); };
      const complexQueryPlan = complexQueryDatabasePlan(name, resolve(dir), servers);
      keep('drop the 18 owner-specific complex-query fixture databases and files', () => dropComplexQueryFixtures(complexQueryPlan, {
        mysql: database => mysqlAt(runMysql, ['-e', `DROP DATABASE IF EXISTS \`${database}\``], env).status === 0,
        postgres: database => result('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', postgresServer(servers['ORM_RUN_POSTGRES_DSN'] ?? ''),
          '-c', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`], env).status === 0,
        sqlite: file => {
          for (const path of [file, `${file}-wal`, `${file}-shm`]) rmSync(path, { force: true });
          return true;
        },
      }, (item, error) => console.error(`databases: cannot drop ${item.runtime}/${item.dialect} fixture ${item.dialect === 'sqlite' ? item.file : item.database}${error === undefined ? '' : `: ${errorMessage(error)}`}; check server access in ${serversPath} and run make orm-test-servers`)));
      keep(`mysql DROP DATABASE ${name}_bench, ${name}_decimal`, () => mysqlAt(runMysql, ['-e', `DROP DATABASE IF EXISTS \`${name}_bench\`; DROP DATABASE IF EXISTS \`${name}_decimal\``], env).status === 0);
      const server = postgresServer(servers['ORM_RUN_POSTGRES_DSN'] ?? '');
      keep(`psql DROP DATABASE ${name}_bench, ${name}_decimal`, () => result('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', server,
        '-c', `DROP DATABASE IF EXISTS "${name}_bench" WITH (FORCE)`, '-c', `DROP DATABASE IF EXISTS "${name}_decimal" WITH (FORCE)`], env).status === 0);
      keep(`rm -rf ${dir}`, () => { rmSync(dir, { recursive: true, force: true }); return true; });
      keep('purge the binary logs', () => purgeBinlogs(serversPath, servers, env));
      if (failed.length) {
        console.error(`databases: drop failed:${failed.map(line => `\n  ${line}`).join('')}`);
        process.exit(1);
      }
      console.log(`databases: ${name}_bench, ${name}_decimal, and complex-query fixture databases dropped`);
      break;
    }
    case 'drop-dead':
      if (!dropDeadRuns(servers, env)) process.exit(1);
      break;
    default:
      console.error(USAGE);
      process.exit(2);
  }
}
