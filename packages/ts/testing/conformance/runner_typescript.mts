// Conformance runner (TypeScript). Runs every vector against the bench
// database and prints {"<vector>": {"statements": [{"sql", "binds", "kind", "tables",
// "transaction", "error"}], "result": …}} with the same chains, result shapes, and masking
// as runner_go. Each statement is its statement event (docs/usage.md "Statement events"):
// transaction is renumbered from 1 in order of appearance within the vector, null outside
// a transaction, and error is the code of the statement's error or null.
//
// Usage: node runner_typescript.mts --dsn URI [--vector NAME]...
// Each --vector selects one vector by name; without one every vector runs.
// The models embed the manifest of contracts/fixtures/bench/bench.dbs.
import {
  AesKeyring, Author, BindCell, CORE, ClockCell, type Collection, type Model, CompositeAccount, HexCell, Service, TimeCell, DayCell, ServiceMember, ServiceRegion, SoftLink, SoftRecord, StyledValue, Task, UpsertCell, User, UuidCell, connect, orm,
} from '../../dist/index.js';
import { fixClock, lastAffected } from '../../dist/testing.js';
import { parseArgs } from 'node:util';
import { derivedInteger, executeVector, resultValue } from './result_typescript.mts';
import { errorMessage } from '../../../../tests/errors.mts';

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
let maskTs = new Set<string>();

function pad(n: number, width = 2): string { return String(n).padStart(width, '0'); }

function timeText(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}000`;
}

/** Hides the identity of rows a vector created, including statements logged earlier. */
function mask(seqs: unknown[], ...times: string[]): void {
  for (const s of seqs) maskSeqs.add(Number(s));
  for (const t of times) maskTs.add(t);
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
    if (maskTs.has(v)) return '$TS';
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
const keysOf = (rows: Collection) => rows.keys();

async function main() {
  const db = await connect(dsn, {
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
  });
  db.subscribe(e => {
    let transaction = null;
    if (e.transaction !== null) {
      if (!transactions.has(e.transaction)) transactions.set(e.transaction, transactions.size + 1);
      transaction = transactions.get(e.transaction) ?? null;
    }
    log.push({ sql: e.sql, binds: e.binds.map(norm), kind: e.kind, tables: [...e.tables], transaction, error: e.error === null ? null : code(e.error) });
  });
  const out: Record<string, { statements: Logged[]; result: unknown }> = {};
  const writeVectors = new Set(['write_cycle', 'now_defaults', 'required_columns', 'creates_and_save', 'delete_recursive', 'contains_ascii_fold', 'contains_binary_code_point', 'datetime_p0_roundtrip', 'time_p3_roundtrip', 'date_roundtrip', 'date_null', 'upsert_one_key', 'affected_counts', 'uuid_roundtrip', 'clock_truncate_write', 'clock_compare_six_digits']);
  const declared = new Set<string>();
  const run = async (name: string, fn: () => Promise<unknown>) => {
    declared.add(name);
    if (selected.length > 0 && !selected.includes(name)) return;
    log = []; transactions = new Map(); maskSeqs = new Set(); maskTs = new Set();
    const res = resultValue(await executeVector(name, fn, writeVectors.has(name) ? task => db.transaction(task, { retry: 0 }) : null));
    out[name] = { statements: log.map(s => ({ sql: s.sql, binds: s.binds, kind: s.kind, tables: s.tables, transaction: s.transaction, error: s.error })), result: res };
  };
  const author = () => new Author().connect(db);
  const cols = ['seq', 'name', 'is_close', 'is_display', 'read_count'];

  await run('conditions_connectors', async () => {
    const rows = await author().serviceSeq(7).andIsClose(false).or().readCount(6).orderBySeqAsc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_group', async () => {
    const rows = await author().serviceSeq(7)
      .and(q => q.isDisplay(false).or(q => q.isClose(true).andGtReadCount(500)))
      .orderBySeqDesc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_leading_group', async () => {
    const rows = await author()
      .and(q => q.isDisplay(false).orIsClose(true))
      .andServiceSeq(7)
      .orderBySeqDesc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_leading_prefix', async () => {
    const rows = await author().andServiceSeq(7).andGtReadCount(990).orderBySeqDesc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_values', async () => {
    const counts = [];
    for (const q of [
      author().serviceSeq([7, 8]).andNeIsClose(true),
      author().serviceSeq(7).andUuid(null),
      author().serviceSeq(7).andNePhotoUrl(null),
      author().serviceSeq(7).andNeReadCount([6, 106, 206]),
      author().serviceSeq(7).andBetweenReadCount([100, 200]),
      author().serviceSeq(7).andLkName('uthor-10'),
      author().serviceSeq(7).andLbName('Author-10'),
      author().serviceSeq(7).andGeReadCount(990),
      author().serviceSeq(7).andLeReadCount(10),
      author().serviceSeq(7).andLtSeq(1000),
    ]) counts.push(await q.getCount());
    return counts;
  });
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
  await run('expression_forms', async () => {
    const count = await author().serviceSeq(7).andNot(q => q.isClose(true).orGtReadCount(500)).getCount();
    const rows = await author().not(q => q.isDisplay(false)).andServiceSeq(7).orderBySeqDesc().limit(0, 3).gets();
    const orCount = await author().serviceSeq(7).orNot(q => q.ltReadCount(990)).getCount();
    return { count, rows: picks(rows, 'seq', 'is_display'), or_count: orCount };
  });
  await run('columns', async () => {
    const none = await new Service().connect(db).removeAllColumns().getBySeq(7);
    const added = await author().removeAllColumns().addColumnName().addColumnStartDtAliasStartYear(orm.year()).getBySeq(42);
    const removed = await new Service().connect(db).removeColumnName().getBySeq(7);
    return [none.toArray(), pick(added, 'seq', 'name', 'start_year'), removed.toArray()];
  });
  await run('joins', async () => {
    const service = new Service().on(s => s.gtSeq(0)).name('service-7');
    const rows = await author()
      .removeAllColumns().addColumnName()
      .joinServiceSeqWithSeq(service)
      .isClose(false)
      .and(q => q.isDisplay(true).or(service))
      .orderBySeqAsc().limit(0, 2).gets();
    const member = new ServiceMember();
    const compared = await author()
      .joinServiceMemberSeqWithSeq(member)
      .serviceSeq(7)
      .andSuccessCountLtSeq(member)
      .getCount();
    const left = await author().leftJoinServiceRegionSeqWithSeq(new ServiceRegion().aliasModule())
      .serviceSeq(7).orderBySeqAsc().limit(0, 1).gets();
    const leftRow = left.first();
    if (leftRow === undefined) throw new Error('the left join of the module returned no row');
    return { rows: rows.toArray(), compared, module: pick(leftRow.getModule(), 'seq', 'name') };
  });
  await run('relations', async () => {
    const rows = await author()
      .removeAllColumns().addColumnName().addColumnIsClose()
      .relation(new User().matchUserSeqWithSeq().aliasWriter()
        .relations(new Author().matchSeqWithUserSeq().removeAllColumns().orderBySeqDesc().groupLimit(2)))
      .relation(new Service().matchServiceSeqWithSeq()
        .relations(new ServiceMember().matchSeqWithServiceSeq().removeAllColumns().orderBySeqAsc().groupLimit(2).keyNameUserSeq()))
      .relation(new ServiceRegion().matchServiceRegionSeqWithSeq().possibleIsClose(true).parentNode())
      .serviceSeq(7).orderBySeqAsc().limit(0, 3).gets();
    return rows.toArray();
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
  await run('relation_null_key', async () => {
    try {
      const rows = await new User().connect(db).relations(new Author().matchSeqWithUserSeq().keyNamePrice()).seq(100).gets();
      return rows.values().length;
    } catch (e) {
      return { error: code(e), message: errorMessage(e) };
    }
  });
  await run('subqueries', async () => {
    const users = await new User().connect(db)
      .addColumnReadTotal(u => new Author().sumReadCount().userSeqEqSeq(u).andServiceSeq(7))
      .seq(new Author().addColumnUserSeq().serviceSeq(7).andGeReadCount(906))
      .orderBySeqAsc().gets();
    return users.values().map(u => [u.getSeq(), derivedInteger(u.getReadTotal())]);
  });
  await run('aggregates', async () => {
    const sum = await author().serviceSeq(7).sumReadCount().getSum();
    const avg = await author().serviceSeq(7).avgLikeCount().getAvg();
    if (avg === null) throw new Error('aggregate average is null');
    const avgBytes = Buffer.alloc(8);
    avgBytes.writeDoubleBE(avg);
    if (avgBytes.toString('hex') !== '404805c28f5c28f6') {
      throw new Error(`aggregate average has unexpected binary64 value: ${avg}`);
    }
    const groups = await author().serviceSeq(7).groupByIsClose().orderByIsCloseAsc().getsCount();
    const page = await author().serviceSeq(7).removeAllColumns().orderBySeqAsc().getsPage(3, 4);
    return {
      sum,
      avg: avg.toFixed(4),
      groups: groups.toArray(),
      page: { keys: keysOf(page.items), total: page.totalCount, pages: page.totalPages, page: page.page, per_page: page.perPage },
    };
  });
  await run('functions', async () => {
    const counts = [];
    for (const q of [
      author().serviceSeq(7).andEqStartDt(orm.dayOfWeek(), 2),
      author().serviceSeq(7).andStartDt(orm.year(), 2026),
      author().serviceSeq(7).andGtStartDt(orm.daysAgo(36500)),
      author().serviceSeq(7).andLtStartDt(orm.monthsLater(1200)),
    ]) counts.push(await q.getCount());
    const rows = await author().removeAllColumns().addColumnStartDtAliasStartMonth(orm.month())
      .orderByStartDtAsc(orm.year()).orderBySeqAsc().getsBySeq([42, 43]);
    return { counts, months: rows.values().map(r => derivedInteger(r.getStartMonth())) };
  });
  await run('errors', async () => {
    const errs: (string | null)[] = [];
    const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); errs.push(null); } catch (error) { errs.push(code(error)); } };
    await attempt(() => author().name('a').isClose(true).gets());
    await attempt(() => author().name('a').and().gets());
    await attempt(() => author().seq([]).gets());
    await attempt(() => new Author().name('a').gets());
    await attempt(() => author().forUpdate().gets());
    await attempt(() => author().joinUserSeqWithSeq(new User().connect(db)).gets());
    await attempt(() => author().limit(0, 1).getsPage(1, 10));
    await attempt(() => author().relation(new User().matchUserSeqWithSeq().limit(0, 1)).getsBySeq(42));
    await attempt(() => author().name('a').or(new User()).gets());
    return errs;
  });
  await run('get_query', async () => {
    const st = await author().serviceSeq(7).andLkName('x').andAesHexEmail('user7@example.com').orderBySeqDesc().limit(0, 5).getQuery();
    return { sql: st.sql, binds: st.binds.map(norm) };
  });
  await run('aes_values', async () => {
    const row = await author().removeAllColumns().addColumnAesHexEmail().addColumnAesHexPhone().getBySeq(42);
    const found = await author().aesHexEmail('user42@example.com').getCount();
    return { row: row.toArray(), found };
  });
  await run('write_cycle', async () => {
    const start = '2026-06-01 00:00:00.000000';
    const created = await author()
      .setName('cycle').setUserSeq(1).setServiceSeq(999).setServiceRegionSeq(1).setServiceMemberSeq(1)
      .setStartDt(start).setEndDt(start).setPrice('12.500').setIp('10.0.0.1').setAesHexEmail('cycle@example.com')
      .setJsonSetting(StyledValue.value({ a: 1 })).setSerializeData(StyledValue.value({ k: 'v' }))
      .newLabel('created')
      .create();
    const seq = created.getSeq();
    mask([seq]);
    const createdArray = created.toArray();
    createdArray.seq = '$SEQ';
    const loaded = await author().addAllColumns().getBySeq(seq);
    mask([], loaded.getUpdatedTs());
    await loaded.setName('cycle-2').plusReadCount(3).update(true);
    let stale = null;
    try { await loaded.setName('stale').update(true); } catch (error) { stale = code(error); }
    const again = await author().addAllColumns().getBySeq(seq);
    const updated = pick(again, 'name', 'read_count', 'price', 'ip', 'aes_hex_email', 'json_setting', 'serialize_data', 'start_dt');
    await again.delete();
    const gone = await caught(author().getBySeq(seq));
    return { created: createdArray, updated, stale, deleted: gone };
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
  await run('required_columns', async () => {
    const failure = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        return { error: code(e), message: errorMessage(e) };
      }
      return null;
    };
    const missingState = await failure(() => new Task().connect(db).setTitle('draft').create());
    const missingTitle = await failure(() => new Task().connect(db).setState('open').create());
    const created = await new Task().connect(db).setTitle('draft').setState('open').create();
    mask([created.getSeq()]);
    await created.delete();
    return { missing_state: missingState, missing_title: missingTitle };
  });
  await run('creates_and_save', async () => {
    const rows = [
      new CompositeAccount().setTenantId(900).setAccountId(1).setName('a'),
      new CompositeAccount().setTenantId(900).setAccountId(2).setName('b'),
      new CompositeAccount().setTenantId(901).setAccountId(1).setName('c'),
    ];
    const inserted = await new CompositeAccount().connect(db).creates(rows, 2);
    await new CompositeAccount().connect(db).setTenantId(900).setAccountId(1).setName('dup')
      .duplication(new CompositeAccount().setName('updated')).create();
    await new CompositeAccount().connect(db).setTenantId(900).setAccountId(2).setName('saved').save();
    const pairs = await new CompositeAccount().connect(db)
      .tupleTenantIdWithAccountId([[900, 1], [900, 2]])
      .orderByAccountIdAsc().gets();
    const all = await new CompositeAccount().connect(db).tenantId([900, 901]).orderByTenantIdAsc().orderByAccountIdAsc().gets();
    await all.delete();
    const left = await new CompositeAccount().connect(db).tenantId([900, 901]).getCount();
    return { inserted, pairs: pairs.toArray(), left };
  });
  // creates(rows, batch) runs each batch of batch rows as one multi-row INSERT in one transaction; a batch that is not
  // a positive integer is CONFIG before any statement (docs/protocol.md).
  await run('creates_batch', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((name, i) => new CompositeAccount().setTenantId(903).setAccountId(i + 1).setName(name));
    const inserted = await new CompositeAccount().connect(db).creates(rows, 2);
    const zero = await caught(new CompositeAccount().connect(db).creates(rows, 0));
    const count = await new CompositeAccount().connect(db).tenantId([903]).getCount();
    await (await new CompositeAccount().connect(db).tenantId([903]).orderByAccountIdAsc().gets()).delete();
    return { inserted, zero, count };
  });
  // A batch whose binds exceed the bind limit is BATCH_TOO_LARGE before any statement: 21846 rows of three columns
  // bind 65538 parameters, over the limit of every dialect.
  await run('creates_batch_too_large', async () => {
    const rows = Array.from({ length: 21846 }, (_, i) => new CompositeAccount().setTenantId(904).setAccountId(i + 1).setName('n'));
    const code = await caught(new CompositeAccount().connect(db).creates(rows, rows.length));
    const count = await new CompositeAccount().connect(db).tenantId([904]).getCount();
    return { code, count };
  });
  // Creates the rows Apple, apple, Évian, évian, and x_y for tenant 902, collects the account_id that each pattern selects with cond, then deletes them.
  const containsVector = async (cond: (p: string) => CompositeAccount, ...patterns: string[]) => {
    const rows = ['Apple', 'apple', 'Évian', 'évian', 'x_y'].map((name, i) => new CompositeAccount().setTenantId(902).setAccountId(i + 1).setName(name));
    await new CompositeAccount().connect(db).creates(rows, rows.length);
    const matches: unknown[] = [];
    for (const p of patterns) matches.push(picks(await cond(p).orderByAccountIdAsc().gets(), 'account_id'));
    await (await new CompositeAccount().connect(db).tenantId(902).orderByAccountIdAsc().gets()).delete();
    return matches;
  };
  await run('contains_ascii_fold', () => containsVector(p => new CompositeAccount().connect(db).tenantId(902).andLkName(p), 'PPL', 'ÉV', '_', ''));
  await run('contains_binary_code_point', () => containsVector(p => new CompositeAccount().connect(db).tenantId(902).andLbName(p), 'pp', 'É', 'PPL', '_'));
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
  await run('transactions', async () => {
    const boom = new Error('boom');
    const events = [];
    let failed;
    try {
      await db.transaction(async () => {
        await new Service().setName('tx-outer').create();
        try {
          await db.transaction(async () => {
            await new Service().setName('tx-inner').create();
            throw boom;
          });
          events.push(false);
        } catch (error) { events.push(error === boom); }
        events.push(await new Service().name(['tx-outer', 'tx-inner']).getCount());
        const locked = await new Service().name('tx-outer').forUpdate().gets();
        events.push(locked.length);
        await db.utils().lock('conformance');
        await db.utils().setLocal('ormtest.actor', 'runner');
        events.push(await db.utils().local('ormtest.actor'));
        throw boom;
      }, { retry: 0 });
    } catch (error) { failed = error; }
    events.push(failed === boom);
    events.push(await new Service().connect(db).name(['tx-outer', 'tx-inner']).getCount());
    return events;
  });
  await run('restore', async () => {
    // Restores a soft-deleted row by its primary key. The deletion time is written as a fixed value, so the binds of every database and runner
    // are the same. The transaction rolls back at the end, so the database stays as it was at the start.
    const boom = new Error('boom');
    const result: Record<string, unknown> = {};
    let failed: unknown;
    try {
      await db.transaction(async () => {
        const created = await new SoftRecord().setName('restore').create();
        const seq = created.getSeq();
        mask([seq]);
        await created.setDeletedAt('2026-01-02 03:04:05.000000').update();
        result.hidden = await caught(new SoftRecord().getBySeq(seq));
        for (const [name, value] of [['restored', 'restore-2'], ['again', 'ignored']] as const) {
          const array = (await new SoftRecord().setSeq(seq).setName(value).restore()).toArray();
          array.seq = '$SEQ';
          result[name] = array;
        }
        result.missing = await caught(new SoftRecord().setSeq(0).restore());
        throw boom;
      }, { retry: 0 });
    } catch (error) { failed = error; }
    if (failed !== boom) throw failed;
    result.left = await new SoftRecord().connect(db).name('restore').getCount();
    return result;
  });
  await run('restore_or_create', async () => {
    // restoreOrCreate restores the soft-deleted row of its key, refuses a live row with ROW_NOT_DELETED and creates a
    // missing key (docs/usage.md "Restore or create a row"). The transaction rolls back at the end, so the database is as it was.
    const boom = new Error('boom');
    const result: Record<string, unknown> = {};
    let failed: unknown;
    try {
      await db.transaction(async () => {
        const created = await new SoftLink().setCode('roc-1').setLabel('first').create();
        mask([created.getSeq()]);
        await created.setDeletedAt('2026-01-02 03:04:05.000000').update();
        const restored = (await new SoftLink().setCode('roc-1').setLabel('second').restoreOrCreate()).toArray();
        restored.seq = '$SEQ';
        result.restored = restored;
        result.live = await caught(new SoftLink().setCode('roc-1').setLabel('third').restoreOrCreate());
        const made = await new SoftLink().setCode('roc-2').setLabel('new').restoreOrCreate();
        mask([made.getSeq()]);
        const createdRow = made.toArray();
        createdRow.seq = '$SEQ';
        result.created = createdRow;
        throw boom;
      }, { retry: 0 });
    } catch (error) { failed = error; }
    if (failed !== boom) throw failed;
    result.left = await new SoftLink().connect(db).getCount();
    return result;
  });
  await run('expect_revision', async () => {
    // expectRevision makes an update or a delete write only while author 42's like_count still holds the expected
    // revision; an update stores revision + 1, and a mismatch is REVISION_CHANGED and writes nothing (docs/dsl.md
    // "Writes"). The transaction rolls back at the end, so the database is as it was.
    const boom = new Error('boom');
    const result: Record<string, unknown> = {};
    const read = async () => {
      const row = await new Author().getBySeq(42);
      return { name: row.getName(), like_count: row.getLikeCount() };
    };
    let failed: unknown;
    try {
      await db.transaction(async () => {
        const before = await read();
        result.before = before;
        const revision = before.like_count;
        await new Author().setSeq(42).setName('revision-1').expectRevision('like_count', revision).update();
        result.updated = await read();
        result.update_mismatch = await caught(new Author().setSeq(42).setName('revision-stale').expectRevision('like_count', revision).update());
        result.after_mismatch = await read();
        result.delete_mismatch = await caught(new Author().setSeq(42).expectRevision('like_count', revision).delete());
        result.kept = await new Author().seq(42).getCount();
        result.delete_match = await caught(new Author().setSeq(42).expectRevision('like_count', revision + 1).delete());
        result.deleted = await new Author().seq(42).getCount();
        throw boom;
      }, { retry: 0 });
    } catch (error) { failed = error; }
    if (failed !== boom) throw failed;
    result.left = await new Author().connect(db).seq(42).getCount();
    return result;
  });
  await run('joins_soft_deleted', async () => {
    // A joined soft_record row that is soft deleted meets no parent: the inner join drops the parent and the left join
    // gives it a null child. The transaction rolls back at the end, so the database is as it was.
    const boom = new Error('boom');
    const names = ['soft-join-live', 'soft-join-deleted'];
    const result: Record<string, unknown> = {};
    let failed: unknown;
    try {
      await db.transaction(async () => {
        for (const name of names) {
          const service = await new Service().setName(name).create();
          const record = await new SoftRecord().setName(name).create();
          mask([service.getSeq(), record.getSeq()]);
          if (name === 'soft-join-deleted') await record.setDeletedAt('2026-01-02 03:04:05.000000').update();
        }
        const inner = await new Service().joinNameWithName(new SoftRecord().aliasRecord()).name(names).orderByNameAsc().gets();
        result.inner = picks(inner, 'name');
        const left = await new Service().leftJoinNameWithName(new SoftRecord().aliasRecord()).name(names).orderByNameAsc().gets();
        result.left = left.values().map(row => ({ name: row.getName(), record: pick(row.getRecord(), 'name') }));
        throw boom;
      }, { retry: 0 });
    } catch (error) { failed = error; }
    if (failed !== boom) throw failed;
    return result;
  });
  await run('column_pairs', async () => {
    // Two compared columns meet as dbspec check operands do (docs/dbspec.md "Checks"): a comparison of two columns, a
    // column in a subquery column, a join and a relation run when their columns meet, here i32 with i64 and text with
    // varchar, and fail with OPERATOR_NOT_ALLOWED before any statement when they do not.
    const result: Record<string, unknown> = {};
    const s1 = new Service();
    result.col_i32_i64 = await author().joinServiceSeqWithSeq(s1).readCountLtSeq(s1).getCount();
    const s2 = new Service();
    result.col_text_varchar = await author().joinServiceSeqWithSeq(s2).descriptionNeName(s2).getCount();
    result.in_i32_i64 = await author().likeCount(new User().addColumnSeq()).getCount();
    result.join_i32_i64 = await author().joinReadCountWithSeq(new Service()).getCount();
    result.relation_i32_i64 = (await author().relation(new Service().matchLikeCountWithSeq()).orderBySeqAsc().limit(0, 2).gets()).values().length;
    const s3 = new Service();
    result.col_varchar_i64 = await caught(author().joinServiceSeqWithSeq(s3).nameEqSeq(s3).getCount());
    const s4 = new Service();
    result.col_decimal_i64 = await caught(author().joinServiceSeqWithSeq(s4).priceEqSeq(s4).getCount());
    result.in_varchar_i64 = await caught(author().name(new User().addColumnSeq()).getCount());
    result.join_varchar_i64 = await caught(author().joinNameWithSeq(new Service()).getCount());
    result.relation_varchar_i64 = await caught(author().relation(new Service().matchNameWithSeq()).limit(0, 1).gets());
    return result;
  });
  await run('relative_time_out_of_range', async () => {
    // A relative time function outside 0001-01-01 to 9999-12-31, or with an interval no database represents, is NULL, so
    // a comparison and its negation both match no row. secondsAgo takes an integer in every client, so 1e15 seconds
    // stands for an interval past every bound.
    const counts: Record<string, unknown> = {};
    for (const [name, f] of [['seconds_ago', orm.secondsAgo(1000000000000000)], ['days_later', orm.daysLater(4000000)], ['months_ago', orm.monthsAgo(200000)]] as const) {
      counts[name] = [await author().andGtStartDt(f).getCount(), await author().andLeStartDt(f).getCount()];
    }
    return counts;
  });
  await run('aes_status', async () => {
    const keyring = new AesKeyring(new Map([[1, 'bench-salt']]), 1);
    const status = await db.utils().aes().status(new Author(), keyring);
    const versions = [...status.versions].map(([v, n]) => `${v}:${n}`).sort();
    return { current: status.current, pending: status.pending, versions: versions.join(',') };
  });
  // the seed stores raw hex cells that no encoder writes (benchmarks/sql/seed.*.sql)
  await run('hex_malformed', async () => ({
    white_space: await caught(new HexCell().connect(db).getBySeq(1)),
    odd_length: await caught(new HexCell().connect(db).getBySeq(2)),
  }));
  // A datetime(p) or time(p) value is bound with exactly p fraction digits, the form the SQLite CHECK of the column
  // requires (docs/dialects.md); zeros past p are dropped. Each vector inserts, reads the row back by the same
  // parameter and deletes it.
  const at = '2026-06-01 12:34:56.000000';
  await run('datetime_p0_roundtrip', async () => {
    const created = await new TimeCell().connect(db).setAt(at).setClock('10:11:12').create();
    mask([created.getSeq()]);
    const rows = await new TimeCell().connect(db).at(at).gets();
    await created.delete();
    return picks(rows, 'clock');
  });
  await run('time_p3_roundtrip', async () => {
    const created = await new TimeCell().connect(db).setAt(at).setClock('10:11:12.345000').create();
    mask([created.getSeq()]);
    const rows = await new TimeCell().connect(db).clock('10:11:12.345').gets();
    await created.delete();
    return picks(rows, 'clock');
  });
  // A date and a time(0) column read back as their text form (the driver's date and time values are the codec's input).
  await run('date_roundtrip', async () => {
    const created = await new DayCell().connect(db).setLabel('date').setDay('2026-06-01').setAtTime('10:11:12').create();
    mask([created.getSeq()]);
    const rows = await new DayCell().connect(db).label('date').gets();
    await created.delete();
    return picks(rows, 'day', 'at_time');
  });
  await run('date_null', async () => {
    const created = await new DayCell().connect(db).setLabel('nil').create();
    mask([created.getSeq()]);
    const rows = await new DayCell().connect(db).label('nil').gets();
    await created.delete();
    return picks(rows, 'day', 'at_time');
  });
  // An upsert has exactly one conflict key (docs/protocol.md 1): upsert_cell leaves its identity primary key out, so the
  // unique key on code is the one key that can meet the row; an insert that does not assign code is IR_INVALID before
  // any statement.
  await run('upsert_one_key', async () => {
    const created = await new UpsertCell().connect(db).setCode('k1').setLabel('first')
      .duplication(new UpsertCell().setLabel('second')).create();
    mask([created.getSeq()]);
    const inserted = await new UpsertCell().connect(db).code('k1').gets();
    await new UpsertCell().connect(db).setCode('k1').setLabel('other').duplication(new UpsertCell().setLabel('second')).create();
    const updated = await new UpsertCell().connect(db).code('k1').gets();
    let unassigned: { error: string | null; message: string } | null = null;
    try {
      await new UpsertCell().connect(db).setLabel('none').duplication(new UpsertCell().setLabel('second')).create();
    } catch (e) {
      unassigned = { error: code(e), message: errorMessage(e) };
    }
    await updated.delete();
    return { inserted: picks(inserted, 'label'), updated: picks(updated, 'label'), unassigned };
  });
  // A PostgreSQL uuid column is read as its text and a uuid value is bound as text cast to uuid, in one form in every
  // planner (docs/dialects.md); the vector inserts, reads the row back by the same value and deletes it.
  await run('uuid_roundtrip', async () => {
    const created = await new UuidCell().connect(db).setId('0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5').create();
    mask([created.getSeq()]);
    const rows = await new UuidCell().connect(db).id('0f8e2d4c-1a3b-4c5d-8e9f-a0b1c2d3e4f5').gets();
    await created.delete();
    return picks(rows, 'id');
  });
  // A write counts each written row once (docs/protocol.md "Write"): an upsert is 1 whether it inserts or updates, and an
  // update counts the row it matched even when the row already holds the value. The count is read through the test
  // entry point (docs/protocol.md "Test write result").
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

  // A value outside the logical type of its slot is CODEC_ENCODE before any statement (docs/protocol.md §5
  // "Parameters"). A create that the client lets through is deleted, so the vector leaves the database as it found it.
  const rejected = async (create: () => Promise<{ getSeq(): number | bigint; delete(): Promise<unknown> }>) => {
    try {
      const created = await create();
      mask([created.getSeq()]);
      await created.delete();
      return { code: null };
    } catch (error) {
      return { code: code(error) };
    }
  };
  await run('datetime_precision_rejected', () => rejected(() => new TimeCell().connect(db).setAt('2026-06-01 12:34:56.500000').setClock('10:11:12').create()));
  await run('varchar_length_rejected', () => rejected(() => new BindCell().connect(db).setLabel('123456789').create()));
  await run('text_nul_rejected', () => rejected(() => new BindCell().connect(db).setLabel('nul').setBody('a\u0000b').create()));
  await run('uuid_form_rejected', () => rejected(() => new BindCell().connect(db).setLabel('uuid').setToken('123E4567-E89B-12D3-A456-426614174000').create()));
  // A contains value NULL binds NULL, so `col LIKE NULL` matches no row (docs/protocol.md §2).
  // A parameter that assigns NULL to a non-null column is CODEC_ENCODE before any statement (docs/protocol.md §5
  // "Parameters"); creates binds each row value as a parameter.
  await run('null_into_not_null', async () => {
    const nullRow = new BindCell();
    nullRow[CORE].setValue('label', null);
    return { code: await caught(new BindCell().connect(db).creates([new BindCell().setLabel('a'), nullRow], 2)) };
  });
  await run('contains_null', async () => {
    try {
      const q = author().serviceSeq(7);
      q[CORE].whereChain('and', [{ conn: '', op: 'lk', column: 'name', columns: [], compare: '' }], [null]);
      return { code: null, count: await q.getCount() };
    } catch (error) {
      return { code: code(error), count: null };
    }
  });

  // One statement has one clock (docs/protocol.md "Clock"): the columns that an insert leaves to `default now` hold that
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
    return { p0_truncated: row.getAt0() === at6.slice(0, 19), p3_truncated: row.getAt3() === at6.slice(0, 23) };
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
  // the seed prices the authors of service 100 except a seq that is a multiple of 3 (benchmarks/sql/seed.*.sql)
  await run('order_nulls', async () => {
    const priced = () => author().removeAllColumns().addColumnPrice().serviceSeq(100).andLtSeq(500);
    const asc = (await priced().orderByPriceAsc().orderBySeqAsc().gets()).toArray();
    const desc = (await priced().orderByPriceDesc().orderBySeqAsc().gets()).toArray();
    const perParent: Record<string, unknown> = {};
    for (const order of ['asc', 'desc']) {
      const child = new Author().matchSeqWithUserSeq().removeAllColumns().addColumnPrice();
      if (order === 'asc') child.orderByPriceAsc(); else child.orderByPriceDesc();
      perParent[order] = (await new User().connect(db).relations(child.orderBySeqAsc().groupLimit(2)).seq(100).gets()).toArray();
    }
    return {
      asc,
      desc,
      limit_per_parent: perParent,
    };
  });
  // user 100 has the authors 99 (price NULL) and 5099 (price 3.000) under seq 10000 (benchmarks/sql/seed.*.sql)
  await run('scalar_column_subquery', async () => {
    const out: Record<string, unknown> = {};
    for (const order of ['asc', 'desc']) {
      const users = await new User().connect(db)
        .addColumnReadTotal(u => {
          const sub = new Author().removeAllColumns().addColumnName().userSeqEqSeq(u).andLtSeq(10000);
          if (order === 'asc') sub.orderByPriceAsc(); else sub.orderByPriceDesc();
          return sub.orderBySeqAsc().limit(0, 1);
        })
        .seq(100).gets();
      out[order] = users.values().map(u => [u.getSeq(), u.getReadTotal()]);
    }
    return out;
  });
  // a flattened region of a closed author (seq, name and service_seq collide with the parent; absent for an open author) that holds a flattened service (seq and name collide) with its service members
  await run('relations_flatten', async () => {
    const rows = await author()
      .removeAllColumns().addColumnName().addColumnIsClose()
      .relation(new ServiceRegion().matchServiceRegionSeqWithSeq().possibleIsClose(true).parentNode()
        .relation(new Service().matchServiceSeqWithSeq().parentNode()
          .relations(new ServiceMember().matchSeqWithServiceSeq().removeAllColumns().orderBySeqAsc().groupLimit(2))))
      .serviceSeq(7).orderBySeqAsc().limit(0, 8).gets();
    return rows.toArray();
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
