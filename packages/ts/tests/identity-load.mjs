// contracts/fixtures/identity_load.json의 공유 case를 TypeScript client로 실행한다. case id 하나가
// case 하나(identity-load/<case id>)다. compile case는 세 dialect의 Engine으로 request를 compile해
// statement나 오류를 비교하고, execute case는 MySQL, PostgreSQL, SQLite마다 새 case
// database(case-database.mjs)에 fixture를 설치한 뒤 각 step의 request를 그 database의 Engine으로
// compile해 Db.execute로 실행하고, 마지막에 file의 read SQL을 native 연결로 실행해 load_probe의 행을
// 비교한다(docs/usage.md "Execute a compiled statement"). 한 dialect가 실패해도 나머지 dialect를
// 실행하고 실패를 모두 보고한다.
//
// Usage: node packages/ts/tests/identity-load.mjs [case ...]
// (after npm run typescript:build; it reads ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN of make test-servers)
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Db, Engine, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { COMPUTE, DATABASE, runCase } from '../../../tests/testcase.mjs';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';

const DIALECTS = ['mysql', 'postgres', 'sqlite'];
const doc = JSON.parse(await readFile(new URL('../../../contracts/fixtures/identity_load.json', import.meta.url), 'utf8'));
const parsed = parseDbspec(await readFile(new URL(`../../../${doc.fixture}`, import.meta.url), 'utf8'), {});
if (parsed.document === null) throw new Error(`fixture ${doc.fixture}: ${JSON.stringify(parsed.diagnostics)}`);
const { manifest } = dbspecManifest([parsed.document]);
const schema = { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
const model = registerModel(manifest.manifestText, manifest.manifestHash);

const selected = process.argv.slice(2);
for (const id of selected) if (!doc.cases.some(c => c.id === id)) throw new Error(`unknown case ${id}`);
const cases = doc.cases.filter(c => selected.length === 0 || selected.includes(c.id));
for (const c of cases) if (c.operation !== 'compile' && c.operation !== 'execute') throw new Error(`case ${c.id}: unknown operation ${c.operation}`);
if (cases.some(c => c.operation === 'execute')) {
  for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
    if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
  }
}

/** request에 fixture의 manifest_hash를 더해 dialect의 Engine으로 compile한다. */
function compile(dialect, request) {
  if ('manifest_hash' in request) throw new Error('the case request already holds manifest_hash');
  return new Engine(model, dialect).compile({ manifest_hash: manifest.manifestHash, ...request });
}

/** compile된 plan step 하나의 role, bind slot(출처, param slot의 번호, dbspec type), SQL, table이다. */
function statementOf(step) {
  // key 순서는 case file의 순서(이름순)다.
  const slots = step.bind_slots.map(slot => {
    const s = { from: slot.from };
    if (slot.from === 'param') s.param = slot.param;
    if (slot.col_type !== '') s.type = slot.col_type;
    return s;
  });
  return { role: step.role, slots, sql: step.sql, tables: step.tables };
}

/** 오류가 code와 message의 OrmError인지다. OrmError의 message는 `<code>: <message>`다. */
function sameError(error, code, message) {
  return error instanceof OrmError && error.code === code && error.message === `${code}: ${message}`;
}

function errorText(error) {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error);
}

/** case의 정수는 이 client의 정수 값 number다. */
function caseParam(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`parameter ${value} is no integer`);
  return value;
}

/** file의 read SQL을 native 연결로 실행해 [seq, label] 행을 돌려준다. seq는 number다. */
async function readRows(dialect, database) {
  const sql = doc.read[dialect];
  let rows;
  if (dialect === 'mysql') {
    const conn = await mysqlConnection(database.dsn);
    try { [rows] = await conn.query({ sql, rowsAsArray: true }); } finally { await conn.end(); }
  } else if (dialect === 'postgres') {
    const client = postgresClient(database.dsn);
    await client.connect();
    try { rows = (await client.query({ text: sql, rowMode: 'array' })).rows; } finally { await client.end(); }
  } else {
    const db = new DatabaseSync(database.path);
    // node:sqlite는 행을 select 순서의 column을 key로 한 object로 돌려준다.
    try { rows = db.prepare(sql).all().map(row => Object.values(row)); } finally { db.close(); }
  }
  return rows.map(([seq, label]) => {
    const n = Number(seq);
    if (!Number.isSafeInteger(n) || String(n) !== String(seq)) throw new Error(`${dialect} read seq ${seq} (${typeof seq}) is no integer`);
    return [n, label];
  });
}

/** compile case의 한 dialect를 확인하고 문제를 problems에 더한다. */
function compileCase(c, dialect, step, problems) {
  const want = c.expected.error === undefined ? 'statements' : `${c.expected.error} ${JSON.stringify(c.expected.message)}`;
  let plan;
  try {
    plan = compile(dialect, c.input);
  } catch (error) {
    if (c.expected.error !== undefined && sameError(error, c.expected.error, c.expected.message)) step(`${dialect}: ${error.message}`);
    else problems.push(`${dialect}: compile threw ${errorText(error)}; want ${want}`);
    return;
  }
  const got = JSON.stringify(plan.steps.map(statementOf));
  if (c.expected.error !== undefined) {
    problems.push(`${dialect}: compile returned ${got}; want ${want}`);
    return;
  }
  const expected = JSON.stringify(c.expected[dialect]);
  if (expected === undefined || got !== expected) problems.push(`${dialect} statements:\n got ${got}\nwant ${expected}`);
  else step(`${dialect}: ${plan.steps.length} statement(s) equal`);
}

/** statement event의 kind다: SQL 동사이고, MySQL identity restart의 ALTER는 schema다(docs/usage.md "Statement events"). */
function eventKind(sql) {
  const kinds = { ALTER: 'schema', INSERT: 'insert', UPDATE: 'update', DELETE: 'delete', SELECT: 'select' };
  const verb = sql.split(' ', 1)[0];
  if (!(verb in kinds)) throw new Error(`statement ${sql} has no known verb`);
  return kinds[verb];
}

/** execute case를 dialect의 새 case database에서 실행하고 행을 비교한다. 실패는 던진다. */
async function executeCase(c, dialect, step) {
  const report = text => step(`${dialect}: ${text}`);
  await withCaseDatabase(dialect, report, async database => {
    const db = await Db.connectSchema(database.dsn, schema);
    try {
      await db.utils().schema().install(schema);
      report('fixture installed');
      const events = [];
      db.subscribe(event => events.push(event));
      for (const [i, s] of c.steps.entries()) {
        const plan = compile(dialect, s.request);
        events.length = 0;
        let error = null;
        try {
          await db.execute(plan.steps[0], s.params.map(caseParam));
        } catch (thrown) { error = thrown; }
        // 실행한 statement는 SQL 동사의 kind로 event 하나를 publish하고, 거부한 step은 statement를 보내지 않는다.
        const want = s.error === undefined ? [{ sql: plan.steps[0].sql, kind: eventKind(plan.steps[0].sql), tables: plan.steps[0].tables }] : [];
        const got = events.map(e => ({ sql: e.sql, kind: e.kind, tables: [...e.tables] }));
        if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`step ${i} ${s.request.kind}: events ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        if (s.error === undefined && error !== null) throw new Error(`step ${i} ${s.request.kind}: execute threw ${errorText(error)}`);
        if (s.error !== undefined && !sameError(error, s.error, s.message)) {
          throw new Error(`step ${i} ${s.request.kind}: execute ${error === null ? 'succeeded' : `threw ${errorText(error)}`}; want ${s.error} ${JSON.stringify(s.message)}`);
        }
        report(`step ${i} ${s.request.kind}: ${error === null ? 'executed' : error.message}`);
      }
    } finally { await db.close(); }
    const got = JSON.stringify(await readRows(dialect, database));
    const want = JSON.stringify(c.expected.rows);
    if (got !== want) throw new Error(`rows = ${got}, want ${want}`);
    report(`rows ${got}`);
  });
}

let failures = 0;
for (const c of cases) {
  const deadline = c.operation === 'compile' ? COMPUTE : DATABASE;
  const passed = await runCase(`identity-load/${c.id}`, deadline, async ({ step }) => {
    const problems = [];
    for (const dialect of DIALECTS) {
      if (c.operation === 'compile') compileCase(c, dialect, step, problems);
      else {
        try { await executeCase(c, dialect, step); } catch (error) { problems.push(`${dialect}: ${errorText(error)}`); }
      }
    }
    if (problems.length > 0) throw new Error(problems.join('\n'));
  });
  if (!passed) failures++;
}
if (failures > 0) process.exitCode = 1;
