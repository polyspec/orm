// case database 검사(T25): 공유 test database(ORM_TEST_MYSQL_DSN의 database, ORM_TEST_POSTGRES_DSN의
// public schema)에 이 검사가 만든 table 하나를 남겨 둔 채로 빈 database를 확인하거나 schema를
// 설치하는 client case를 실행한다. 그 case들이 모두 통과하고, 공유 database의 table과 row
// (tests/conformance/check state의 digest), PostgreSQL schema 목록이 그대로이며, case가 만든
// `orm_case_` database와 `orm-case-` SQLite file이 하나도 남지 않아야 한다. 남겨 둔 table은
// 검사가 끝날 때(실패한 뒤에도) 지운다.
//
// Usage: node scripts/case-database-check.mjs (TEST_ENV를 읽은 shell에서, TypeScript build와
// Rust integration release build 뒤)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DATABASE, PROCESS, runCase, runGroup, stepLines } from '../tests/testcase.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(resolve(root, 'clients/typescript/package.json'));
const mysqlDsn = process.env.ORM_TEST_MYSQL_DSN;
const postgresDsn = process.env.ORM_TEST_POSTGRES_DSN;
if (!mysqlDsn) throw new Error('ORM_TEST_MYSQL_DSN is required; database checks never skip');
if (!postgresDsn) throw new Error('ORM_TEST_POSTGRES_DSN is required; database checks never skip');
const secrets = [mysqlDsn, postgresDsn];
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

function mysqlConnection() {
  const url = new URL(mysqlDsn);
  return require('mysql2/promise').createConnection({
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname,
    port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1),
  });
}

async function postgres(statements) {
  const url = new URL(postgresDsn);
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

async function mysql(statements) {
  const connection = await mysqlConnection();
  try {
    const results = [];
    for (const statement of statements) results.push((await connection.query(statement))[0]);
    return results;
  } finally { await connection.end(); }
}

// program을 실행하고 출력 줄을 step으로 보고한다. 종료 상태가 0이 아니면 실패다.
function execute(program, args, step) {
  return new Promise((done, fail) => {
    const child = spawn(program, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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

let failed = false;
async function check(name, deadline, body) {
  if (!(await runCase(name, deadline, body))) failed = true;
  return !failed;
}

let before;
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
    const changed = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    if (changed.length) throw new Error(`changed by the cases: ${changed.map(key => `${key} ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`).join('; ')}`);
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
