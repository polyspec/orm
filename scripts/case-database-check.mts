// Case database check (T25): leave the one table this check created in the shared test database, then run client cases that
// check an empty database or install a schema. All those cases must pass, and the shared
// database's tables and rows (the digest of tests/conformance/check/main.mts state), the PostgreSQL schema list,
// stay the same, and no `orm_case_` database or `orm-case-` SQLite file made by the cases may remain.
//
// A leftover case database or file counts as left over only if it was not there before the run and its named process has ended.
// Those of a running process belong to another run's case (T27). The shared test database is the one PgBouncer's
// orm_test_single points to, so this check cannot create its own; its digest and PostgreSQL
// schema list can be compared when no other session on the same server runs tests.
//
// Usage: node scripts/case-database-check.mts (in a shell that has read TEST_ENV,
// after the TypeScript build and the Rust integration debug build)
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DATABASE, PROCESS, runCase, runGroup, stepLines, type CaseBody } from '../tests/testcase.mts';

import { cargoTarget } from '../tests/cargo-target.mts';
import { errorCode } from '../tests/errors.mts';
import mysqlDriver from 'mysql2/promise';
import pg from 'pg';

const root = resolve(new URL('..', import.meta.url).pathname);
// required is the value of an environment variable that the check needs; database checks never skip.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; database checks never skip; run the test through its make target, which reads the environment of make test-servers`);
  return value;
}
const mysqlDsn = required('ORM_TEST_MYSQL_DSN');
const postgresDsn = required('ORM_TEST_POSTGRES_DSN');
const secrets = [mysqlDsn, postgresDsn];
const redact = (text: string) => secrets.reduce((out, dsn) => out.replaceAll(dsn, '[redacted]'), String(text));
const leftover = `orm_leftover_${process.pid}`;

// If a case that reads the shared database is changed and a case still treats the database as empty, these commands
// fail. Each command reports its own cases (Go and TypeScript print RUN/STEP/PASS/FAIL, PHP prints PHPUnit), so run them as a group.
const commands: [string, string, string[]][] = [
  ['go/schema-empty', 'go', ['test', '-v', '-timeout', '0', '-count=1', './packages/go/orm', '-run', '^TestSchemaEmpty$']],
  ['go/model', 'go', ['test', '-v', '-timeout', '0', '-count=1', './packages/go/model']],
  ['php/model', 'php', ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', 'packages/php/tests/ModelTest.php']],
  ['typescript/model', 'node', ['packages/ts/tests/model.mjs']],
  ['rust/integration', join(cargoTarget(), 'debug/integration'), [resolve(root, 'contracts/fixtures/bench/dbspec-set.json')]],
];

function mysqlConnection(dsn: string = mysqlDsn) {
  const url = new URL(dsn);
  const socketPath = url.searchParams.get('socket');
  return mysqlDriver.createConnection({
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, database: url.pathname.slice(1),
    ...(socketPath === null ? {} : { socketPath }), ...(url.port ? { port: Number(url.port) } : {}),
  });
}

// postgres and mysql run the statements in order on a new connection and give the rows of each.
async function postgres(statements: string[], dsn: string = postgresDsn): Promise<unknown[][]> {
  const url = new URL(dsn);
  const client = new pg.Client({
    host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined,
    database: url.pathname.slice(1), user: decodeURIComponent(url.username) || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  });
  await client.connect();
  try {
    const results: unknown[][] = [];
    for (const statement of statements) results.push((await client.query(statement)).rows);
    return results;
  } finally { await client.end(); }
}

async function mysql(statements: string[], dsn: string = mysqlDsn): Promise<unknown[][]> {
  const connection = await mysqlConnection(dsn);
  try {
    const results: unknown[][] = [];
    for (const statement of statements) {
      const [rows] = await connection.query(statement);
      results.push(Array.isArray(rows) ? rows : [rows]);
    }
    return results;
  } finally { await connection.end(); }
}

// Runs the program and reports its output lines as steps. A nonzero exit status is a failure.
function execute(program: string, args: string[], step: (text: string) => void): Promise<void> {
  return new Promise<void>((done, fail) => {
    const child = spawn(program, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = stepLines(text => step(redact(text)));
    child.stdout.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => lines.write(String(chunk)));
    child.on('error', fail);
    child.on('close', (code, signal) => {
      lines.flush();
      if (code === 0) done();
      else fail(new Error(`${program} exited with ${code ?? signal}`));
    });
  });
}

// The table and row digest of the shared database (tests/conformance/check/main.mts state).
async function digest(database: string, dsn: string): Promise<string> {
  let output = '';
  await execute(process.execPath, [join(root, 'tests/conformance/check/main.mts'), 'state', '--driver', database, '--dsn', dsn], (text: string) => { output += `${text}\n`; });
  const match = new RegExp(`^${database} state ([a-f0-9]{64})$`, 'm').exec(output);
  if (!match?.[1]) throw new Error(`${database}: invalid state reader output: ${redact(output)}`);
  return match[1];
}

// Traces outside the shared database. Case database names and SQLite file names begin with `orm_case_`,
// `orm-case-`; PostgreSQL schemas are counted by content in empty(), so they are checked too.
// names reads the name column of the rows of a statement.
function names(rows: unknown[] | undefined): string[] {
  return (rows ?? []).map(row => {
    if (typeof row !== 'object' || row === null || !('name' in row) || typeof row.name !== 'string') throw new Error(`a row without a name: ${JSON.stringify(row)}`);
    return row.name;
  });
}

/** The traces of the cases outside the shared databases. */
type Traces = { mysqlDatabases: string[]; postgresDatabases: string[]; postgresSchemas: string[]; files: string[] };

async function traces(): Promise<Traces> {
  const [mysqlDatabases] = await mysql(["SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'orm\\_case\\_%' ORDER BY 1"]);
  const [postgresDatabases, schemas] = await postgres([
    "SELECT datname AS name FROM pg_database WHERE datname LIKE 'orm\\_case\\_%' ORDER BY 1",
    "SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1",
  ]);
  const files = (await readdir(tmpdir())).filter(name => name.startsWith('orm-case-')).sort();
  return {
    mysqlDatabases: names(mysqlDatabases),
    postgresDatabases: names(postgresDatabases),
    postgresSchemas: names(schemas),
    files,
  };
}

// alive means the process with pid is running. Processes of other users are also counted as running.
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === 'EPERM'; }
}

// leftovers are case databases and files absent before the run whose named process has ended. Their names are
// `orm_case_<pid>_<n>` and `orm-case-<pid>-<n>.sqlite`. All of this check's client cases have ended, so
// what that process left stays here.
function leftovers(before: string[], after: string[]): string[] {
  return after.filter(name => !before.includes(name)).filter(name => {
    const match = /^orm[_-]case[_-]([0-9]+)[_-]/.exec(name);
    return !match || !alive(Number(match[1]));
  });
}

let failed = false;
async function check(name: string, deadline: number, body: CaseBody): Promise<boolean> {
  if (!(await runCase(name, deadline, body))) failed = true;
  return !failed;
}

/** The state of the shared databases and the traces of the cases. */
type Snapshot = Traces & { mysql: string; postgres: string };

let before: Snapshot | undefined;
let created = false;
try {
  await check('case-database/leftover', DATABASE, async ({ step }) => {
    await mysql([`CREATE TABLE \`${leftover}\` (id int PRIMARY KEY)`]);
    created = true;
    await mysql([`INSERT INTO \`${leftover}\` (id) VALUES (1)`]);
    await postgres([`CREATE TABLE "${leftover}" (id int PRIMARY KEY)`, `INSERT INTO "${leftover}" (id) VALUES (1)`]);
    step(`table ${leftover} with one row in the shared MySQL database and PostgreSQL public schema`);
  });
  if (!failed) await check('case-database/before', PROCESS, async ({ step }) => {
    before = { mysql: await digest('mysql', mysqlDsn), postgres: await digest('postgres', postgresDsn), ...await traces() };
    step(`shared state mysql ${before.mysql} postgres ${before.postgres}`);
    step(`traces ${JSON.stringify({ mysqlDatabases: before.mysqlDatabases, postgresDatabases: before.postgresDatabases, postgresSchemas: before.postgresSchemas, files: before.files })}`);
  });
  for (const [name, program, args] of failed ? [] : commands) {
    if (!(await runGroup(`case-database/${name}`, ({ step }) => execute(program, args, step)))) failed = true;
  }
  if (before) await check('case-database/after', PROCESS, async ({ step }) => {
    const after = { mysql: await digest('mysql', mysqlDsn), postgres: await digest('postgres', postgresDsn), ...await traces() };
    step(`shared state mysql ${after.mysql} postgres ${after.postgres}`);
    const earlier = before;
    if (earlier === undefined) throw new Error('case-database/before recorded no state');
    const changed = (['mysql', 'postgres', 'postgresSchemas'] as const).filter(key => JSON.stringify(earlier[key]) !== JSON.stringify(after[key]))
      .map(key => `${key} ${JSON.stringify(earlier[key])} -> ${JSON.stringify(after[key])}`);
    for (const key of ['mysqlDatabases', 'postgresDatabases', 'files'] as const) {
      const left = leftovers(earlier[key], after[key]);
      if (left.length) changed.push(`${key} left ${JSON.stringify(left)}`);
    }
    if (changed.length) throw new Error(`changed by the cases: ${changed.join('; ')}`);
    step('the shared databases, the PostgreSQL schemas, the orm_case_ databases and the orm-case- files are unchanged');
  });
} finally {
  if (created) await check('case-database/remove-leftover', DATABASE, async ({ step }) => {
    await mysql([`DROP TABLE \`${leftover}\``]);
    await postgres([`DROP TABLE IF EXISTS "${leftover}"`]);
    step(`table ${leftover} dropped`);
  });
}
if (failed) process.exitCode = 1;
