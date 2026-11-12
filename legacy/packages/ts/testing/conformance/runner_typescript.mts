// Conformance runner (TypeScript). Runs the bodies that no recipe step reaches, the generated-method and the
// fixed-clock bodies (tests/conformance/README.md), against a database and prints
// {"<vector>": {"statements": [{"sql", "binds", "kind", "tables", "transaction", "error"}], "result": …}} with the same chains, result shapes, and masking
// as runner_go. Each statement is its statement event (docs/operations/usage.md "Statement events"):
// transaction is renumbered from 1 in order of appearance within the vector, null outside
// a transaction, and error is the code of the statement's error or null.
//
// Usage: node runner_typescript.mts --dsn URI [--vector NAME]...
// Each --vector selects one vector by name; without one every vector runs.
// The models embed the manifest of contracts/fixtures/bench/bench.dbs.
import {
  Author, ClockCell, type Collection, type Model, HexCell, Service, ServiceMember, UpsertCell, connect, orm,
} from '../../dist/index.js';
import { fixClock, lastAffected } from '../../dist/testing.js';
import { parseArgs } from 'node:util';
import { executeVector, resultValue } from './result_typescript.mts';
import { errorMessage } from '../../../../../tests/errors.mts';

const usage = 'usage: runner_typescript.mts --dsn URI [--vector NAME]...';

/** Reads --dsn URI once and --vector NAME any number of times, each name once, with node:util parseArgs. */
function readArguments(args: string[]): { dsn: string; vectors: string[] } {
  const { values } = parseArgs({ args, options: { dsn: { type: 'string', multiple: true }, vector: { type: 'string', multiple: true } }, strict: true, allowPositionals: false });
  if ((values.dsn?.length ?? 0) > 1) throw new Error(`--dsn is given more than once; ${usage}`);
  const dsn = values.dsn?.[0];
  const vectors = values.vector ?? [];
  if (dsn === undefined || dsn === '') throw new Error(`--dsn is required; ${usage}; give the DSN of the bench database with --dsn`);
  if (vectors.includes('')) throw new Error(`--vector requires a nonempty value; ${usage}`);
  const twice = vectors.find((name, index) => vectors.indexOf(name) !== index);
  if (twice !== undefined) throw new Error(`vector ${twice} is selected twice`);
  return { dsn, vectors };
}

let parsed: { dsn: string; vectors: string[] };
try { parsed = readArguments(process.argv.slice(2)); } catch (error) {
  console.error(errorMessage(error));
  process.exit(2);
}
const { dsn, vectors: selected } = parsed;

/** One statement event of a vector as every runner writes it. */
type Logged = { sql: string; binds: unknown[]; kind: string; tables: string[]; transaction: number | null; error: string | null };

let log: Logged[] = [];
// transactions renumbers the transaction numbers in a vector by their order of first appearance.
let transactions = new Map<unknown, number>();
let maskSeqs = new Set<number>();

function pad(n: number, width = 2): string { return String(n).padStart(width, '0'); }

function timeText(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}000`;
}

/** Hides the identity of rows a vector created, including statements logged earlier. */
function mask(seqs: unknown[]): void {
  for (const s of seqs) maskSeqs.add(Number(s));
  for (const s of log) s.binds = s.binds.map(norm);
}

/** Renders a bound value the way every runner does. */
function norm(v: unknown): unknown {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error('integer query bind exceeds the exact JSON range');
    }
    v = Number(v);
  }
  if (typeof v === 'number') return Number.isInteger(v) && maskSeqs.has(v) ? '$SEQ' : v;
  if (v instanceof Date) return norm(timeText(v));
  if (v instanceof Uint8Array) {
    const prefix = Buffer.from('ORM-AES2\0');
    if (Buffer.from(v.subarray(0, prefix.length)).equals(prefix)) {
      if (v.length < 9 + 12 + 16) throw new Error('invalid AES ciphertext bind');
      return '$AES';
    }
    return norm(new TextDecoder('utf-8', { fatal: true }).decode(v));
  }
  if (typeof v === 'string') {
    if (v.startsWith('ORM-AES2')) throw new Error('invalid AES ciphertext bind');
    if (v.toLowerCase().startsWith('4f524d2d41455332')) {
      if (v.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(v)) throw new Error('invalid hex AES ciphertext bind');
      const decoded = Buffer.from(v, 'hex');
      if (!decoded.subarray(0, 9).equals(Buffer.from('ORM-AES2\0')) || decoded.length < 9 + 12 + 16) {
        throw new Error('invalid hex AES ciphertext bind');
      }
      return '$AES';
    }
  }
  return v;
}

/** The code of the error of a promise, or null when it resolves. */
async function caught(promise: Promise<unknown>): Promise<string | null> {
  try { await promise; return null; } catch (error) { return code(error); }
}

function code(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code !== '') return error.code;
  return errorMessage(error);
}

/** Keeps the named values of a row. */
function pick(m: Model | null | undefined, ...names: string[]): Record<string, unknown> | null {
  if (m === null || m === undefined) return null;
  const all = m.toArray();
  const out: Record<string, unknown> = {};
  for (const n of names) {
    if (!Object.hasOwn(all, n)) throw new Error(`missing selected field: ${n}`);
    out[n] = all[n];
  }
  return out;
}

const picks = (rows: Collection, ...names: string[]) => rows.values().map(m => pick(m, ...names));

async function main() {
  const db = await connect(dsn, {
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
    auditSource: () => ({}),
  });
  await db.transaction(async () => {}, { retry: 0 });
  db.subscribe(e => {
    let transaction = null;
    if (e.transaction !== null) {
      if (!transactions.has(e.transaction)) transactions.set(e.transaction, transactions.size + 1);
      transaction = transactions.get(e.transaction) ?? null;
    }
    log.push({ sql: e.sql, binds: e.binds.map(norm), kind: e.kind, tables: [...e.tables], transaction, error: e.error === null ? null : code(e.error) });
  });
  const out: Record<string, { statements: Logged[]; result: unknown }> = {};
  const writeVectors = new Set(['now_defaults', 'delete_recursive', 'affected_counts', 'clock_truncate_write', 'clock_compare_six_digits']);
  const declared = new Set<string>();
  const run = async (name: string, fn: () => Promise<unknown>) => {
    declared.add(name);
    if (selected.length > 0 && !selected.includes(name)) return;
    log = []; transactions = new Map(); maskSeqs = new Set();
    const res = resultValue(await executeVector(name, fn, writeVectors.has(name) ? task => db.transaction(task, { retry: 0 }) : null));
    out[name] = { statements: log.map(s => ({ sql: s.sql, binds: s.binds, kind: s.kind, tables: s.tables, transaction: s.transaction, error: s.error })), result: res };
  };
  const author = () => new Author().connect(db);
  const cols = ['seq', 'name', 'is_close', 'is_display', 'read_count'];

  await run('terminal_by', async () => {
    const one = await author().getBySeq(42);
    const missing = await caught(author().getBySeq(-1));
    const rows = await author().orderBySeqAsc().limit(0, 2).getsByServiceSeqAndIsClose(7, false);
    const count = await author().getCountByServiceSeq(7);
    return { one: pick(one, ...cols), missing, rows: picks(rows, ...cols), count };
  });
  await run('terminal_reuse', async () => {
    const q = author().serviceSeq(7).orderBySeqAsc().limit(0, 2);
    const first = await q.getCountByIsClose(true);
    const rows = await q.gets();
    const last = await q.getCount();
    return [first, rows.length, last];
  });
  await run('relation_empty', async () => {
    const rows = await author().relations(new ServiceMember().matchUserSeqWithUserSeq()).getsBySeq(-1);
    return rows.length;
  });
  await run('empty_reads', async () => {
    const none = () => author().seq(-1);
    // The reads run in the order of the other runners, so the statements agree.
    const get = await none().get();
    const getBy = await author().getBySeq(-1);
    const gets = (await none().gets()).length;
    const groups = (await none().groupByIsClose().getsCount()).toArray();
    const page = await none().removeAllColumns().orderBySeqAsc().getsPage(1, 10);
    return {
      get,
      get_by: getBy,
      gets,
      gets_count: groups,
      page: { items: page.items.length, total_count: page.totalCount, total_pages: page.totalPages, page: page.page, per_page: page.perPage },
      count: await none().getCount(),
      sum: await none().sumReadCount().getSum(),
      avg: await none().avgLikeCount().getAvg(),
      null_rows: await author().price(null).getCount(),
      null_sum: await author().price(null).sumPrice().getSum(),
      null_avg: await author().price(null).avgPrice().getAvg(),
    };
  });
  await run('aes_values', async () => {
    const row = await author().removeAllColumns().addColumnAesHexEmail().addColumnAesHexPhone().getBySeq(42);
    const found = await author().aesHexEmail('user42@example.com').getCount();
    return { row: row.toArray(), found };
  });
  await run('now_defaults', async () => {
    const start = '2026-06-01 00:00:00.000000';
    const before = Date.now();
    const created = await author()
      .setName('clock').setUserSeq(1).setServiceSeq(999).setServiceRegionSeq(1).setServiceMemberSeq(1)
      .setStartDt(start).setEndDt(start)
      .create();
    const seq = created.getSeq();
    mask([seq]);
    const loaded = await author().getBySeq(seq);
    const createdTs = loaded.getCreatedTs();
    const updatedTs = loaded.getUpdatedTs();
    // The runner connects in +00:00, so the wall-clock text is UTC.
    const near = Math.abs(Date.parse(createdTs.replace(' ', 'T') + 'Z') - before) < 60_000;
    await loaded.delete();
    return { created_near_clock: near, created_equals_updated: createdTs === updatedTs };
  });
  await run('delete_recursive', async () => {
    const service = await new Service().connect(db).setName('recursive').create();
    const seq = service.getSeq();
    const seqs = [seq];
    for (let i = 0; i < 2; i++) {
      const member = await new ServiceMember().connect(db).setServiceSeq(seq).setUserSeq(i + 1).create();
      seqs.push(member.getSeq());
    }
    const loaded = await new Service().connect(db)
      .relations(new ServiceMember().matchSeqWithServiceSeq())
      .getBySeq(seq);
    const members = loaded.getServiceMemberModels<Collection<ServiceMember>>().length;
    mask(seqs);
    await loaded.delete(true);
    const left = await new ServiceMember().connect(db).getCountByServiceSeq(seq);
    const service2 = await caught(new Service().connect(db).getBySeq(seq));
    return { members, members_left: left, service_left: service2 };
  });
  // the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
  await run('hex_malformed', async () => ({
    white_space: await caught(new HexCell().connect(db).getBySeq(1)),
    odd_length: await caught(new HexCell().connect(db).getBySeq(2)),
  }));
  // A write counts each written row once (docs/spec/protocol.md "Write"): an upsert is 1 whether it inserts or updates, and an
  // update counts the row it matched even when the row already holds the value. The count is read through the test
  // entry point (docs/spec/protocol.md "Test write result").
  await run('affected_counts', async () => {
    const out: Record<string, number | null> = {};
    const upsert = () => new UpsertCell().connect(db).setCode('c1').setLabel('x').duplication(new UpsertCell().setLabel('y')).create();
    const created = await upsert();
    mask([created.getSeq()]);
    out.upsert_inserted = lastAffected(db);
    await upsert();
    out.upsert_updated = lastAffected(db);
    const row = await new UpsertCell().connect(db).getBySeq(created.getSeq());
    await row.setLabel('y').update();
    out.update_unchanged = lastAffected(db);
    await row.setLabel('z').update();
    out.update_changed = lastAffected(db);
    await row.delete();
    return out;
  });

  // One statement has one clock (docs/spec/protocol.md "Clock"): the columns that an insert leaves to `default now` hold that
  // clock truncated to their digits, and a datetime(p) column compares with a clock at six digits. The executor clock is
  // fixed at .999999 through the test entry point, so a rounding clock shows as the next second; MySQL writes its own
  // clock, CURRENT_TIMESTAMP(p), which truncates. These vectors come last because the fixed clock stays on the connection.
  await run('clock_truncate_write', async () => {
    fixClock(db, '2026-06-01 12:34:56.999999');
    const created = await new ClockCell().connect(db).setLabel('write').create();
    mask([created.getSeq()]);
    const row = await new ClockCell().connect(db).getBySeq(created.getSeq());
    await row.delete();
    const at6 = row.getAt6();
    return { at6_fixed: at6 === '2026-06-01 12:34:56.999999', p0_truncated: row.getAt0() === at6.slice(0, 19), p3_truncated: row.getAt3() === at6.slice(0, 23) };
  });
  await run('clock_compare_six_digits', async () => {
    fixClock(db, '2026-06-01 12:34:56.999999');
    const created = await new ClockCell().connect(db).setLabel('compare')
      .setAt0('2026-06-01 12:34:56.000000').setAt3('2026-06-01 12:34:56.999000')
      .setAt6('2026-06-01 12:34:56.000000').create();
    mask([created.getSeq()]);
    const geNow = await new ClockCell().connect(db).label('compare').andGeAt0(orm.now()).getCount();
    const ltNow = await new ClockCell().connect(db).label('compare').andLtAt3(orm.now()).getCount();
    await created.delete();
    return { at0_ge_now: geNow, at3_lt_now: ltNow };
  });

  await db.close();
  const unknown = selected.filter(name => !declared.has(name));
  if (unknown.length > 0) throw new Error(`unknown vector ${unknown.join(', ')}`);
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

main().catch(error => {
  console.error('runner_typescript:', error);
  process.exit(1);
});
