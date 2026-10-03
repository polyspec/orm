// Conformance runner (TypeScript). Runs every vector against the bench
// database and prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}
// with the same chains, result shapes, and masking as runner_go.
//
// Usage: node runner_typescript.mjs --dsn URI [--vector NAME]...
// Each --vector selects one vector by name; without one every vector runs.
// The models embed the manifest of schema/bench.dbs.
import {
  AesKeyring, Author, CompositeAccount, Service, ServiceMember, ServiceRegion, StyledValue, Task, User, connect, orm,
} from '../../clients/typescript/dist/index.js';
import { derivedInteger, executeVector, resultValue } from './result_typescript.mjs';

const usage = 'usage: runner_typescript.mjs --dsn URI [--vector NAME]...';

/** Reads --dsn URI once and --vector NAME any number of times, each name once. */
function parseArgs(args) {
  let dsn = null;
  const vectors = [];
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (value === undefined || value === '') throw new Error(`${flag} requires a nonempty value; ${usage}`);
    if (flag === '--dsn' && dsn === null) dsn = value;
    else if (flag === '--vector' && !vectors.includes(value)) vectors.push(value);
    else if (flag === '--vector') throw new Error(`vector ${value} is selected twice`);
    else throw new Error(`unexpected argument ${flag}; ${usage}`);
  }
  if (dsn === null) throw new Error(`--dsn is required; ${usage}`);
  return { dsn, vectors };
}

let parsed;
try { parsed = parseArgs(process.argv.slice(2)); } catch (error) {
  console.error(error.message);
  process.exit(2);
}
const { dsn, vectors: selected } = parsed;

let log = [];
let maskSeqs = new Set();
let maskTs = new Set();

function pad(n, width = 2) { return String(n).padStart(width, '0'); }

function timeText(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}000`;
}

/** Hides the identity of rows a vector created, including statements logged earlier. */
function mask(seqs, ...times) {
  for (const s of seqs) maskSeqs.add(Number(s));
  for (const t of times) maskTs.add(t);
  for (const s of log) s.binds = s.binds.map(norm);
}

/** Renders a bound value the way every runner does. */
function norm(v) {
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
async function caught(promise) {
  try { await promise; return null; } catch (error) { return code(error); }
}

function code(error) {
  if (error === undefined || error === null) return null;
  if (typeof error.code === 'string' && error.code !== '') return error.code;
  return error.message ?? String(error);
}

/** Replaces each ordered-json value of a result with plain JSON data. */
/** Keeps the named values of a row. */
function pick(m, ...names) {
  if (m === null || m === undefined) return null;
  const all = m.toArray();
  const out = {};
  for (const n of names) {
    if (!Object.hasOwn(all, n)) throw new Error(`missing selected field: ${n}`);
    out[n] = all[n];
  }
  return out;
}

const picks = (rows, ...names) => rows.values().map(m => pick(m, ...names));
const keysOf = rows => rows.keys();

async function main() {
  const db = await connect(dsn, {
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
    onQuery: e => { log.push({ sql: e.sql, binds: e.binds.map(norm) }); },
  });
  const out = {};
  const writeVectors = new Set(['write_cycle', 'now_defaults', 'required_columns', 'creates_and_save', 'delete_recursive']);
  const declared = new Set();
  const run = async (name, fn) => {
    declared.add(name);
    if (selected.length > 0 && !selected.includes(name)) return;
    log = []; maskSeqs = new Set(); maskTs = new Set();
    let res;
    res = resultValue(await executeVector(name, fn, writeVectors.has(name) ? task => db.transaction(task, { retry: 0 }) : null));
    out[name] = { statements: log.map(s => ({ sql: s.sql, binds: s.binds })), result: res };
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
      author().serviceSeq(7).andLkName('attle-10'),
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
  await run('raw_forms', async () => {
    const count = await author().serviceSeq(7).andRaw('{read_count} > ?', 990).getCount();
    const rows = await author().raw('{seq} IN (?, ?)', 42, 43)
      .removeAllColumns().addRawColumnDoubled('({read_count} * ?)', 2)
      .orderByRaw('{seq} DESC').gets();
    return { count, rows: rows.values().map(r => [r.getSeq(), derivedInteger(r.getDoubled())]) };
  });
  await run('columns', async () => {
    const none = await new Service().connect(db).removeAllColumns().getBySeq(7);
    const added = await author().removeAllColumns().addColumnName().addColumnReadCountAliasReadText("CONCAT('r', %s)").getBySeq(42);
    const removed = await new Service().connect(db).removeColumnName().getBySeq(7);
    return [none.toArray(), pick(added, 'seq', 'name', 'read_text'), removed.toArray()];
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
    return { rows: rows.toArray(), compared, module: pick(left.first().getModule(), 'seq', 'name') };
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
    const errs = [];
    const attempt = async fn => { try { await fn(); errs.push(null); } catch (error) { errs.push(code(error)); } };
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
    const start = new Date(Date.UTC(2026, 5, 1));
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
    const start = new Date(Date.UTC(2026, 5, 1));
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
    const failure = async (fn) => {
      try {
        await fn();
      } catch (e) {
        return { error: code(e), message: e.message };
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
    const inserted = await new CompositeAccount().connect(db).creates(rows);
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
    const members = loaded.getServiceMemberModels().length;
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
  await run('aes_status', async () => {
    const keyring = new AesKeyring(new Map([[1, 'bench-salt']]), 1);
    const status = await db.utils().aes().status(new Author(), keyring);
    const versions = [...status.versions].map(([v, n]) => `${v}:${n}`).sort();
    return { current: status.current, pending: status.pending, versions: versions.join(',') };
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
