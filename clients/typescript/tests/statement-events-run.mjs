// tests/events/vectors.json의 statement event case를 TypeScript client로 MySQL, PostgreSQL,
// SQLite에서 실행하고 기록한 event를 vector의 기대 event와 비교한다(docs/usage.md
// "Statement events"). case마다 새 case database(case-database.mjs)에 fixture
// contracts/fixtures/statement_events.dbs를 설치하고(install이 false인 case는 빼고), 새 연결에
// 기록하는 subscriber 하나를 등록한 뒤 step을 차례로 실행한다. transaction 번호는 case 안에서
// 처음 나온 순서로 1부터 다시 세고, compare가 "tables"인 case는 table을 가리키는 event만 비교한다.
// elapsed는 0 이상인지 확인한다.
//
// statement-events.mjs와 coverage_statement_events.mjs가 이 실행부를 쓴다.
import { readFile } from 'node:fs/promises';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

export const vectors = JSON.parse(await readFile(new URL('../../../tests/events/vectors.json', import.meta.url), 'utf8'));
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

/** case c를 dialect의 database dsn에서 실행하고, 기대 event와 다르면 check로 보고한다. */
export async function runEventCase(c, dialect, dsn, check) {
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

/**
 * vector의 server_transactions를 PostgreSQL case database dsn에서 실행한다. probe가 돌려주는 backend의
 * local transaction 번호 차이로 page 실행 한 번의 server transaction을 센다. pool size 1이므로 모든
 * statement가 한 backend에서 실행된다.
 */
export async function runServerTransactions(spec, dsn, check) {
  const setup = await Db.connectSchema(dsn, schema);
  try { await setup.utils().schema().install(schema); } finally { await setup.close(); }
  const db = await Db.connectSchema(dsn, schema, { poolSize: 1 });
  try {
    const u = db.utils();
    const zone = await u.read('utility', [], "SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'");
    // pooler를 거치면 pooler가 startup parameter를 server connection에 SET으로 적용하므로
    // source는 client를 말하지 않는다. source는 server에 바로 닿을 때만 비교한다.
    const pooled = process.env.ORM_TEST_POSTGRES_DSN !== process.env.ORM_TEST_POSTGRES_SERVER_DSN;
    check(zone.length === 1 && zone[0][0] === spec.time_zone.setting && (pooled || zone[0][1] === spec.time_zone.source),
      `TimeZone setting and source = ${JSON.stringify(zone)}, want ${JSON.stringify(spec.time_zone)}${pooled ? ' (pooled)' : ''}`);
    const probe = async () => Number((await u.read('utility', [], spec.probe))[0][0]);
    const first = await probe();
    const cost = await probe() - first;
    const run = new EventRun(db, check);
    const page = vectors.cases.find(c => c.id === spec.page);
    const compareFirst = spec.first_run_clients.includes('typescript');
    let before = await probe();
    for (const name of ['first', 'second']) {
      run.records = [];
      for (const s of page.steps) await run.checked(s);
      const events = run.records.filter(r => r.sql !== spec.probe).length;
      const after = await probe();
      const transactions = after - before - cost;
      before = after;
      console.log(`server_transactions ${name} run: ${events} events, ${transactions} transactions`);
      if (name === 'second' || compareFirst) check(transactions === events, `${name} run spent ${transactions} server transactions for ${events} statement events, want one per event`);
    }
  } finally { await db.close(); }
}
