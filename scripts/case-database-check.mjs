// case database 검사(T25): 공유 test database에 이 검사가 만든 table 하나를 남겨 둔 채로 빈
// database를 확인하거나 schema를 설치하는 client case를 실행한다. 그 case들이 모두 통과하고, 공유
// database의 table과 row(tests/conformance/check state의 digest), PostgreSQL schema 목록이
// 그대로이며, case가 만든 `orm_case_` database와 `orm-case-` SQLite file이 하나도 남지 않아야 한다.
//
// 다른 실행이나 session이 같은 server에서 test를 실행해도 검사가 흔들리지 않도록(T27), case에 줄
// 공유 test database는 이 검사가 만드는 자기 database `orm_shared_<pid>_<random>`(MySQL,
// PostgreSQL)다. ORM_TEST_MYSQL_DSN과 ORM_TEST_POSTGRES_DSN은 그것을 만들고 지우는 관리 연결로만
// 쓰고, client case에는 그 database를 가리키는 DSN을 준다. 남은 case database와 file은 실행 전에
// 없던 것 가운데 이름의 process가 끝난 것만 센다. 실행 중인 process의 것은 다른 실행의 case다.
// 검사가 끝날 때(실패한 뒤에도) 자기 database를 지운다.
//
// Usage: node scripts/case-database-check.mjs (TEST_ENV를 읽은 shell에서, TypeScript build와
// Rust integration release build 뒤)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DATABASE, PROCESS, runCase, runGroup, stepLines } from '../tests/testcase.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(resolve(root, 'clients/typescript/package.json'));
const adminMysqlDsn = process.env.ORM_TEST_MYSQL_DSN;
const adminPostgresDsn = process.env.ORM_TEST_POSTGRES_DSN;
if (!adminMysqlDsn) throw new Error('ORM_TEST_MYSQL_DSN is required; database checks never skip');
if (!adminPostgresDsn) throw new Error('ORM_TEST_POSTGRES_DSN is required; database checks never skip');
const shared = `orm_shared_${process.pid}_${randomBytes(4).toString('hex')}`;
// withDatabase는 DSN의 database(path)만 바꾼다.
const withDatabase = (dsn, name) => {
  const url = new URL(dsn);
  url.pathname = `/${name}`;
  return url.toString();
};
const mysqlDsn = withDatabase(adminMysqlDsn, shared);
const postgresDsn = withDatabase(adminPostgresDsn, shared);
const secrets = [adminMysqlDsn, adminPostgresDsn, mysqlDsn, postgresDsn];
const redact = text => secrets.reduce((out, dsn) => out.replaceAll(dsn, '[redacted]'), String(text));
const leftover = `orm_leftover_${process.pid}`;

// 공유 database를 읽는 case를 고친 뒤에도 그 database를 빈 것으로 여기는 case가 있으면 이 명령들이
// 실패한다. 각 명령은 자기 case를 RUN/STEP/PASS/FAIL로 보고하므로 묶음(group)으로 실행한다.
const commands = [
  ['go/schema-empty', 'go', ['test', '-v', '-timeout', '0', '-count=1', './clients/go/orm', '-run', '^TestSchemaEmpty$']],
  ['go/model', 'go', ['test', '-v', '-timeout', '0', '-count=1', './clients/go/model']],
  ['php/model', 'php', ['clients/php/tests/model_test.php']],
  ['typescript/model', 'node', ['clients/typescript/tests/model.mjs']],
  ['rust/integration', resolve(root, 'clients/rust/target/release/integration'), [resolve(root, 'schema/bench.dbs')]],
];

function mysqlConnection(dsn = mysqlDsn) {
  const url = new URL(dsn);
  return require('mysql2/promise').createConnection({
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname,
    port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1),
  });
}

async function postgres(statements, dsn = postgresDsn) {
  const url = new URL(dsn);
  const { Client } = require('pg');
  const client = new Client({
    host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined,
    database: url.pathname.slice(1), user: decodeURIComponent(url.username) || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  });
  await client.connect();
  try {
    const results = [];
    for (const statement of statements) results.push((await client.query(statement)).rows);
    return results;
  } finally { await client.end(); }
}

async function mysql(statements, dsn = mysqlDsn) {
  const connection = await mysqlConnection(dsn);
  try {
    const results = [];
    for (const statement of statements) results.push((await connection.query(statement))[0]);
    return results;
  } finally { await connection.end(); }
}

// program을 실행하고 출력 줄을 step으로 보고한다. 종료 상태가 0이 아니면 실패다.
function execute(program, args, step) {
  return new Promise((done, fail) => {
    const env = { ...process.env, ORM_TEST_MYSQL_DSN: mysqlDsn, ORM_TEST_POSTGRES_DSN: postgresDsn };
    const child = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = stepLines(text => step(redact(text)));
    child.stdout.on('data', chunk => lines.write(String(chunk)));
    child.stderr.on('data', chunk => lines.write(String(chunk)));
    child.on('error', fail);
    child.on('close', (code, signal) => {
      lines.flush();
      if (code === 0) done();
      else fail(new Error(`${program} exited with ${code ?? signal}`));
    });
  });
}

// 공유 database의 table과 row digest(tests/conformance/check state)다.
async function digest(database, dsn) {
  let output = '';
  await execute('go', ['run', './tests/conformance/check', 'state', '-driver', database, '-dsn', dsn], text => { output += `${text}\n`; });
  const match = new RegExp(`^${database} state ([a-f0-9]{64})$`, 'm').exec(output);
  if (!match) throw new Error(`${database}: invalid state reader output: ${redact(output)}`);
  return match[1];
}

// 공유 database 밖의 흔적이다. case database 이름과 SQLite file 이름은 `orm_case_`,
// `orm-case-`로 시작하고, PostgreSQL schema는 empty()가 내용으로 세므로 함께 본다.
async function traces() {
  const [mysqlDatabases] = await mysql(["SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'orm\\_case\\_%' ORDER BY 1"]);
  const [postgresDatabases, schemas] = await postgres([
    "SELECT datname AS name FROM pg_database WHERE datname LIKE 'orm\\_case\\_%' ORDER BY 1",
    "SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1",
  ]);
  const files = (await readdir(tmpdir())).filter(name => name.startsWith('orm-case-')).sort();
  return {
    mysqlDatabases: mysqlDatabases.map(row => row.name),
    postgresDatabases: postgresDatabases.map(row => row.name),
    postgresSchemas: schemas.map(row => row.name),
    files,
  };
}

// alive는 pid의 process가 실행 중인지다. 다른 사용자의 process도 실행 중으로 센다.
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// leftovers는 before에 없던 case database와 file 가운데 이름의 process가 끝난 것이다. 이름은
// `orm_case_<pid>_<n>`과 `orm-case-<pid>-<n>.sqlite`다. 이 검사의 client case는 모두 끝났으므로
// 그 process가 남긴 것은 여기에 남는다.
function leftovers(before, after) {
  return after.filter(name => !before.includes(name)).filter(name => {
    const match = /^orm[_-]case[_-]([0-9]+)[_-]/.exec(name);
    return !match || !alive(Number(match[1]));
  });
}

let failed = false;
async function check(name, deadline, body) {
  if (!(await runCase(name, deadline, body))) failed = true;
  return !failed;
}

let before;
let created = false;
let owned = false;
try {
  await check('case-database/shared', DATABASE, async ({ step }) => {
    owned = true;
    await mysql([`CREATE DATABASE \`${shared}\``], adminMysqlDsn);
    await postgres([`CREATE DATABASE "${shared}"`], adminPostgresDsn);
    step(`shared test database ${shared} created on MySQL and PostgreSQL`);
  });
  if (!failed) await check('case-database/leftover', DATABASE, async ({ step }) => {
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
    const changed = ['mysql', 'postgres', 'postgresSchemas'].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    for (const key of ['mysqlDatabases', 'postgresDatabases', 'files']) {
      const left = leftovers(before[key], after[key]);
      if (left.length) changed.push(`${key} left ${JSON.stringify(left)}`);
    }
    if (changed.length) throw new Error(`changed by the cases: ${changed.map(key => before[key] === undefined ? key : `${key} ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`).join('; ')}`);
    step('the shared databases, the PostgreSQL schemas, the orm_case_ databases and the orm-case- files are unchanged');
  });
} finally {
  if (created) await check('case-database/remove-leftover', DATABASE, async ({ step }) => {
    await mysql([`DROP TABLE \`${leftover}\``]);
    await postgres([`DROP TABLE IF EXISTS "${leftover}"`]);
    step(`table ${leftover} dropped`);
  });
  if (owned) await check('case-database/remove-shared', DATABASE, async ({ step }) => {
    await mysql([`DROP DATABASE IF EXISTS \`${shared}\``], adminMysqlDsn);
    await postgres([`DROP DATABASE IF EXISTS "${shared}" WITH (FORCE)`], adminPostgresDsn);
    step(`shared test database ${shared} dropped`);
  });
}
if (failed) process.exitCode = 1;
