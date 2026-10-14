// case database 검사(T25): 공유 test database에 이 검사가 만든 table 하나를 남겨 둔 채로 빈
// database를 확인하거나 schema를 설치하는 client case를 실행한다. 그 case들이 모두 통과하고, 공유
// database의 table과 row(tests/conformance/check/main.mts state의 digest), PostgreSQL schema 목록이
// 그대로이며, case가 만든 `orm_case_` database와 `orm-case-` SQLite file이 하나도 남지 않아야 한다.
//
// 남은 case database와 file은 실행 전에 없던 것 가운데 이름의 process가 끝난 것만 남은 것으로
// 본다. 실행 중인 process의 것은 다른 실행의 case다(T27). 공유 test database는 PgBouncer의
// orm_test_single이 가리키는 database이므로 이 검사가 따로 만들 수 없고, 그 digest와 PostgreSQL
// schema 목록은 같은 server에서 다른 session이 test를 실행하지 않을 때 비교할 수 있다.
//
// Usage: node scripts/case-database-check.mts (TEST_ENV를 읽은 shell에서, TypeScript build와
// Rust integration debug build 뒤)
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

// 공유 database를 읽는 case를 고친 뒤에도 그 database를 빈 것으로 여기는 case가 있으면 이 명령들이
// 실패한다. 각 명령은 자기 case를 보고하므로(Go와 TypeScript는 RUN/STEP/PASS/FAIL, PHP는 PHPUnit) 묶음(group)으로 실행한다.
const commands: [string, string, string[]][] = [
  ['go/schema-empty', 'go', ['test', '-v', '-timeout', '0', '-count=1', './packages/go/orm', '-run', '^TestSchemaEmpty$']],
  ['go/model', 'go', ['test', '-v', '-timeout', '0', '-count=1', './packages/go/model']],
  ['php/model', 'php', ['vendor-php/bin/phpunit', '--configuration', 'packages/php/phpunit.xml.dist', 'packages/php/tests/ModelTest.php']],
  ['typescript/model', 'node', ['packages/ts/tests/model.mjs']],
  ['rust/integration', join(cargoTarget(), 'debug/integration'), [resolve(root, 'contracts/fixtures/bench/bench.dbs')]],
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

// program을 실행하고 출력 줄을 step으로 보고한다. 종료 상태가 0이 아니면 실패다.
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

// 공유 database의 table과 row digest(tests/conformance/check/main.mts state)다.
async function digest(database: string, dsn: string): Promise<string> {
  let output = '';
  await execute(process.execPath, [join(root, 'tests/conformance/check/main.mts'), 'state', '--driver', database, '--dsn', dsn], (text: string) => { output += `${text}\n`; });
  const match = new RegExp(`^${database} state ([a-f0-9]{64})$`, 'm').exec(output);
  if (!match?.[1]) throw new Error(`${database}: invalid state reader output: ${redact(output)}`);
  return match[1];
}

// 공유 database 밖의 흔적이다. case database 이름과 SQLite file 이름은 `orm_case_`,
// `orm-case-`로 시작하고, PostgreSQL schema는 empty()가 내용으로 세므로 함께 본다.
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

// alive는 pid의 process가 실행 중인지다. 다른 사용자의 process도 실행 중으로 센다.
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === 'EPERM'; }
}

// leftovers는 before에 없던 case database와 file 가운데 이름의 process가 끝난 것이다. 이름은
// `orm_case_<pid>_<n>`과 `orm-case-<pid>-<n>.sqlite`다. 이 검사의 client case는 모두 끝났으므로
// 그 process가 남긴 것은 여기에 남는다.
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
