// Runs the shared cases of contracts/fixtures/identity_load.json with the TypeScript client. One case ID
// is one case (a node:test test <case id>). A compile case compiles the request with the Engines of the three dialects
// and compares the statements or errors. An execute case runs on a new case
// database (case-database.mjs) for each of MySQL, PostgreSQL, and SQLite, installs the fixture, then compiles each step's request with that database's Engine
// and runs it with Db.execute. At the end, it runs the file's read SQL over a native connection and
// compares the load_probe rows (docs/usage.md "Execute a compiled statement"). Even if one dialect fails, the rest of the dialects
// still run, and all failures are reported.
//
// Usage: node packages/ts/tests/identity-load.mjs [case ...]
// (after npm run typescript:build; it reads ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN of make test-servers)
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Db, Engine, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { COMPUTE, DATABASE, caseTest } from '../../../tests/testcase.mts';
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

/** Adds the fixture's manifest_hash to the request and compiles it with the dialect's Engine. */
function compile(dialect, request) {
  if ('manifest_hash' in request) throw new Error('the case request already holds manifest_hash');
  return new Engine(model, dialect).compile({ manifest_hash: manifest.manifestHash, ...request });
}

/** The role, bind slot (source, param slot number, dbspec type), SQL, and table of one compiled plan step. */
function statementOf(step) {
  // The key order is the order in the case file (by name).
  const slots = step.bind_slots.map(slot => {
    const s = { from: slot.from };
    if (slot.from === 'param') s.param = slot.param;
    if (slot.col_type !== '') s.type = slot.col_type;
    return s;
  });
  return { role: step.role, slots, sql: step.sql, tables: step.tables };
}

/** The error as an OrmError with its code and message. The message of an OrmError is `<code>: <message>`. */
function sameError(error, code, message) {
  return error instanceof OrmError && error.code === code && error.message === `${code}: ${message}`;
}

function errorText(error) {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error);
}

/** The case's integer is this client's integer value, a number. */
function caseParam(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`parameter ${value} is no integer`);
  return value;
}

/** Runs the file's read SQL over a native connection and returns [seq, label] rows. seq is a number. */
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
    // node:sqlite returns each row as an object keyed by the columns in select order.
    try { rows = db.prepare(sql).all().map(row => Object.values(row)); } finally { db.close(); }
  }
  return rows.map(([seq, label]) => {
    const n = Number(seq);
    if (!Number.isSafeInteger(n) || String(n) !== String(seq)) throw new Error(`${dialect} read seq ${seq} (${typeof seq}) is no integer`);
    return [n, label];
  });
}

/** Checks one dialect of a compile case and adds any problem to problems. */
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

/** The kind of a statement event: the SQL verb, and the ALTER of a MySQL identity restart is schema (docs/usage.md "Statement events"). */
function eventKind(sql) {
  const kinds = { ALTER: 'schema', INSERT: 'insert', UPDATE: 'update', DELETE: 'delete', SELECT: 'select' };
  const verb = sql.split(' ', 1)[0];
  if (!(verb in kinds)) throw new Error(`statement ${sql} has no known verb`);
  return kinds[verb];
}

/** Runs an execute case on a new case database for the dialect and compares rows. Failures are thrown. */
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
        // An executed statement publishes one event with the SQL verb as its kind, and a rejected step sends no statement.
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

for (const c of cases) {
  const deadline = c.operation === 'compile' ? COMPUTE : DATABASE;
  caseTest(c.id, deadline, async ({ step }) => {
    const problems = [];
    for (const dialect of DIALECTS) {
      if (c.operation === 'compile') compileCase(c, dialect, step, problems);
      else {
        try { await executeCase(c, dialect, step); } catch (error) { problems.push(`${dialect}: ${errorText(error)}`); }
      }
    }
    if (problems.length > 0) throw new Error(problems.join('\n'));
  });
}
