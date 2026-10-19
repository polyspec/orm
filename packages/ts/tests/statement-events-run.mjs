// Runs the statement event cases of tests/events/vectors.json with the TypeScript client on MySQL, PostgreSQL,
// and SQLite, and compares the recorded events with the expected events of the vector (docs/operations/usage.md
// "Statement events"). For each case, the fixture
// contracts/fixtures/statement_events.dbs is installed in a new case database (case-database.mjs), except for cases whose install is false, and then on a new connection
// a subscriber that records events is registered, and then the steps are run in order. Transaction numbers are numbered
// again from 1 in order of first appearance within the case, and for a case whose compare is "tables", only events that point to a table are compared.
// Checks that elapsed is 0 or more.
//
// statement-events.mjs and coverage_statement_events.mjs use this runner.
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

/** The error that a failing transaction callback throws. */
const callbackError = new Error('callback failed');

/** A bind value read back from JSON. A bigint becomes a number. */
function jsonValue(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? Number(v) : v));
}

/** The state for running one case. */
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

  /** Runs one step. Failures are thrown. */
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
   * Runs the step and checks that its error is the one the step expected. An unexpected error is thrown, ending the case.
   * A callback error that a transaction step expected is treated as handled by the outer callback.
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

/** A value read back from JSON. Its key order and number form become the same. */
function normalized(records) {
  return JSON.stringify(records.map(r => ({ sql: r.sql, binds: r.binds, kind: r.kind, tables: r.tables, transaction: r.transaction, error: r.error })), null, 2);
}

/** Runs case c on the dialect's database dsn, and reports it with check if the events differ from the expected events. */
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
 * Runs the server_transactions of the vector on the PostgreSQL case database dsn. The backend that the probe returns
 * is used to count the server transactions of one page run by the difference in local transaction numbers. Since the pool size is 1, all
 * statements run on one backend.
 */
export async function runServerTransactions(spec, dsn, check) {
  const setup = await Db.connectSchema(dsn, schema);
  try { await setup.utils().schema().install(schema); } finally { await setup.close(); }
  const db = await Db.connectSchema(dsn, schema, { poolSize: 1 });
  try {
    const u = db.utils();
    const zone = await u.read('utility', [], "SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'");
    // Through a pooler, the pooler applies the startup parameters to the server connection with SET, so
    // the source does not identify the client. The source is compared only when connecting directly to the server.
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
