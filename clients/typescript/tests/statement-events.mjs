// tests/events/vectors.json의 statement event case를 TypeScript client로 MySQL, PostgreSQL,
// SQLite에서 실행하고 기록한 event를 vector의 기대 event와 비교한다(docs/usage.md
// "Statement events"). case마다 새 case database(case-database.mjs)에 fixture
// contracts/fixtures/statement_events.dbs를 설치하고(install이 false인 case는 빼고), 새 연결에
// 기록하는 subscriber 하나를 등록한 뒤 step을 차례로 실행한다. transaction 번호는 case 안에서
// 처음 나온 순서로 1부터 다시 세고, compare가 "tables"인 case는 table을 가리키는 event만 비교한다.
// elapsed는 0 이상인지 확인한다.
//
// Usage: node clients/typescript/tests/statement-events.mjs [--dialect mysql|postgres|sqlite]... [case ...]
// (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { DATABASE, runCase } from '../../../tests/testcase.mjs';
import { withCaseDatabase } from './case-database.mjs';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

const vectors = JSON.parse(await readFile(new URL('../../../tests/events/vectors.json', import.meta.url), 'utf8'));
const fixtureText = await readFile(new URL(`../../../${vectors.fixture}`, import.meta.url), 'utf8');

const parsed = parseDbspec(fixtureText, {});
if (parsed.document === null) throw new Error(JSON.stringify(parsed.diagnostics));
const { manifest } = dbspecManifest([parsed.document]);
const schema = { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
const runtime = registerModel(manifest.manifestText, manifest.manifestHash);
const entity = [...runtime.entities.values()].find(e => e.table === 'event_probe');
const EventProbe = class extends Model {};
EventProbe.entity = { model: runtime, entity, create: core => new EventProbe(core) };

/** 실패하는 transaction callback이 던지는 오류다. */
const callbackError = new Error('callback failed');

/** bind를 JSON으로 다시 읽은 값이다. bigint는 number가 된다. */
function jsonValue(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? Number(v) : v));
}

/** case 하나를 실행하는 상태다. */
class EventRun {
  constructor(db, check) {
    this.db = db;
    this.check = check;
    this.records = [];
    this.numbers = new Map();
    this.stopRecording = db.subscribe(event => this.record(event));
    this.stopFailing = undefined;
  }

  record(event) {
    this.check(typeof event.elapsed === 'number' && event.elapsed >= 0, `event ${JSON.stringify(event.sql)} has the elapsed time ${event.elapsed}`);
    this.check(event.error === null || event.error instanceof OrmError, `event ${JSON.stringify(event.sql)} has the error ${event.error}`);
    let transaction = null;
    if (event.transaction !== null) {
      if (!this.numbers.has(event.transaction)) this.numbers.set(event.transaction, this.numbers.size + 1);
      transaction = this.numbers.get(event.transaction);
    }
    this.records.push({
      sql: event.sql, binds: jsonValue(event.binds), kind: event.kind, tables: [...event.tables],
      transaction, error: event.error === null ? null : event.error.code,
    });
  }

  model() { return new EventProbe().connect(this.db); }

  byLabel(label) {
    const m = this.model();
    m[CORE].whereChain('', [{ conn: '', op: '', column: 'label', columns: [], compare: '' }], [label]);
    return m;
  }

  /** step 하나를 실행한다. 실패는 던진다. */
  async step(s) {
    switch (s.op) {
      case 'create': {
        const m = this.model();
        m[CORE].setValue('label', s.label);
        await m.create();
        return;
      }
      case 'get':
        await this.byLabel(s.label).get();
        return;
      case 'count': {
        const n = await this.model().getCount();
        if (s.result !== undefined) this.check(n === s.result, `count = ${n}, want ${s.result}`);
        return;
      }
      case 'update': {
        const m = await this.byLabel(s.label).get();
        m[CORE].setValue('label', s.to);
        await m.update();
        return;
      }
      case 'delete': {
        const m = await this.byLabel(s.label).get();
        await m.delete();
        return;
      }
      case 'transaction':
        await this.db.transaction(async () => {
          for (const inner of s.steps) await this.checked(inner);
          if (s.fail) throw callbackError;
        }, { retry: 0 });
        return;
      case 'install':
        await this.db.utils().schema().install(schema);
        return;
      case 'fail_subscriber':
        this.stopFailing = this.db.subscribe(event => {
          if (event.kind === s.kind) throw new Error('subscriber refused the event');
        });
        return;
      case 'stop_failing':
        this.stopFailing();
        return;
      case 'unsubscribe':
        this.stopRecording();
        return;
    }
    throw new Error(`unknown step ${s.op}`);
  }

  /**
   * step을 실행하고 그 오류가 step이 기대한 것인지 확인한다. 기대하지 않은 오류는 던져 case를 끝낸다.
   * transaction step이 기대한 callback 오류는 바깥 callback에서 처리된 것으로 본다.
   */
  async checked(s) {
    let error;
    try { await this.step(s); } catch (caught) { error = caught; }
    if (s.error === undefined) {
      if (error !== undefined) throw new Error(`step ${s.op}: ${error?.message ?? error}`);
      return;
    }
    if (s.error === 'callback') {
      if (error !== callbackError) throw new Error(`step ${s.op} = ${error?.message ?? error}, want the callback error`);
      return;
    }
    if (!(error instanceof OrmError) || error.code !== s.error) throw new Error(`step ${s.op} = ${error?.message ?? error}, want ${s.error}`);
    if (s.error === 'SUBSCRIBER') this.check(error.cause instanceof Error && error.cause.message === 'subscriber refused the event', `SUBSCRIBER keeps the subscriber error as its cause: ${error.cause}`);
  }
}

/** JSON으로 다시 읽은 값이다. key 순서와 숫자 형태가 같아진다. */
function normalized(records) {
  return JSON.stringify(records.map(r => ({ sql: r.sql, binds: r.binds, kind: r.kind, tables: r.tables, transaction: r.transaction, error: r.error })), null, 2);
}

async function runEventCase(c, dialect, dsn, check) {
  const db = await Db.connectSchema(dsn, schema);
  try {
    if (c.install !== false) await db.utils().schema().install(schema);
    const run = new EventRun(db, check);
    for (const s of c.steps) await run.checked(s);
    const got = c.compare === 'tables' ? run.records.filter(r => r.tables.length > 0) : run.records;
    const want = normalized(c.events[dialect]);
    const have = normalized(got);
    check(have === want, `${dialect} events\n got ${have}\nwant ${want}`);
  } finally { await db.close(); }
}

const args = process.argv.slice(2);
const dialects = [];
const selected = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dialect') dialects.push(args[++i]);
  else selected.push(args[i]);
}
const cases = vectors.cases.filter(c => selected.length === 0 || selected.includes(c.id));
for (const id of selected) if (!vectors.cases.some(c => c.id === id)) throw new Error(`unknown case ${id}`);
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip`);
}
let failures = 0;
for (const dialect of dialects.length > 0 ? dialects : ['mysql', 'postgres', 'sqlite']) {
  for (const c of cases) {
    const name = `statement_events/${c.id}/${dialect}`;
    let failed = 0;
    const check = (cond, message) => { if (!cond) { failed++; console.error(`FAIL ${name}: ${message}`); } };
    const passed = await runCase(name, DATABASE, async ({ step }) => {
      await withCaseDatabase(dialect, step, database => runEventCase(c, dialect, database.dsn, check));
      if (failed > 0) throw new Error(`${failed} check(s) failed; each FAIL line above names one`);
    });
    if (!passed) failures++;
  }
}
if (failures > 0) process.exitCode = 1;
