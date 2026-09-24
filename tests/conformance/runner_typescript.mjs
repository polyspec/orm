// Conformance runner (TypeScript). Runs every vector against the bench
// database and prints {"<vector>": {"statements": [{"sql", "binds"}], "result": …}}
// with the same chains, result shapes, and masking as runner_go.
//
// Usage: node runner_typescript.mjs [--driver mysql|postgres|sqlite] [--dsn URI] <schema.json>
import {
  AesKeyring, Battle, CompositeAccount, Db, Service, ServiceMember, ServiceModule, User, orm,
} from '../../clients/typescript/dist/index.js';
import { Value as JsonValue, stringify as stringifyJson } from '../../clients/typescript/node_modules/ordered-json/js/index.js';

const args = process.argv.slice(2);
let driver = 'mysql';
let dsnFlag = '';
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--driver') driver = args[++i];
  else if (args[i] === '--dsn') dsnFlag = args[++i];
  else rest.push(args[i]);
}
if (rest.length !== 1) {
  console.error('usage: runner_typescript.mjs [--driver mysql|postgres|sqlite] [--dsn URI] <schema.json>');
  process.exit(2);
}

function dsn() {
  if (dsnFlag !== '') return dsnFlag;
  switch (driver) {
    case 'postgres': return 'postgres:///orm_bench?host=/tmp&timezone=%2B00:00';
    case 'sqlite': return 'sqlite:///tmp/orm_bench.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00';
  }
  return 'mysql://root@localhost/orm_bench?socket=/tmp/mysql.sock&timezone=%2B00:00';
}

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
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'number') return Number.isInteger(v) && maskSeqs.has(v) ? '$SEQ' : v;
  if (v instanceof Date) return norm(timeText(v));
  if (v instanceof Uint8Array) return norm(Buffer.from(v).toString('utf8'));
  if (typeof v === 'string') {
    if (maskTs.has(v)) return '$TS';
    // AES ciphertexts carry a random nonce: raw or hex-encoded.
    if (v.startsWith('ORM-AES2') || v.toLowerCase().startsWith('4f524d2d41455332')) return '$AES';
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
function plain(value) {
  if (value instanceof JsonValue) return JSON.parse(stringifyJson(value));
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

/** Keeps the named values of a row. */
function pick(m, ...names) {
  if (m === null || m === undefined) return null;
  const all = m.toArray();
  const out = {};
  for (const n of names) out[n] = n in all ? all[n] : null;
  return out;
}

const picks = (rows, ...names) => rows.values().map(m => pick(m, ...names));
const keysOf = rows => rows.keys();

async function main() {
  const db = await Db.connect(dsn(), rest[0], {
    aesKey: 'bench-salt',
    blindIndexKey: 'bench-blind-index',
    onQuery: e => { log.push({ sql: e.sql, binds: e.binds.map(norm) }); },
  });
  const out = {};
  const run = async (name, fn) => {
    log = []; maskSeqs = new Set(); maskTs = new Set();
    let res;
    try { res = plain(await fn()); } catch (error) { res = { error: code(error) }; }
    out[name] = { statements: log.map(s => ({ sql: s.sql, binds: s.binds })), result: res };
  };
  const battle = () => new Battle().connect(db);
  const cols = ['seq', 'name', 'is_close', 'is_display', 'read_count'];

  await run('conditions_connectors', async () => {
    const rows = await battle().serviceSeq(7).andIsClose(false).or().readCount(6).orderBySeqAsc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_group', async () => {
    const rows = await battle().serviceSeq(7)
      .and(q => q.isDisplay(false).or(q => q.isClose(true).andGtReadCount(500)))
      .orderBySeqDesc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_leading_group', async () => {
    const rows = await battle()
      .and(q => q.isDisplay(false).orIsClose(true))
      .andServiceSeq(7)
      .orderBySeqDesc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_leading_prefix', async () => {
    const rows = await battle().andServiceSeq(7).andGtReadCount(990).orderBySeqDesc().limit(0, 3).gets();
    return picks(rows, ...cols);
  });
  await run('conditions_values', async () => {
    const counts = [];
    for (const q of [
      battle().serviceSeq([7, 8]).andNeIsClose(true),
      battle().serviceSeq(7).andUuid(null),
      battle().serviceSeq(7).andNeCoverUrl(null),
      battle().serviceSeq(7).andNeReadCount([6, 106, 206]),
      battle().serviceSeq(7).andBetweenReadCount([100, 200]),
      battle().serviceSeq(7).andLkName('attle-10'),
      battle().serviceSeq(7).andLbName('Battle-10'),
      battle().serviceSeq(7).andGeReadCount(990),
      battle().serviceSeq(7).andLeReadCount(10),
      battle().serviceSeq(7).andLtSeq(1000),
    ]) counts.push(await q.getCount());
    return counts;
  });
  await run('terminal_by', async () => {
    const one = await battle().getBySeq(42);
    const missing = await caught(battle().getBySeq(-1));
    const rows = await battle().orderBySeqAsc().limit(0, 2).getsByServiceSeqAndIsClose(7, false);
    const count = await battle().getCountByServiceSeq(7);
    return { one: pick(one, ...cols), missing, rows: picks(rows, ...cols), count };
  });
  await run('terminal_reuse', async () => {
    const q = battle().serviceSeq(7).orderBySeqAsc().limit(0, 2);
    const first = await q.getCountByIsClose(true);
    const rows = await q.gets();
    const last = await q.getCount();
    return [first, rows.length, last];
  });
  await run('raw_forms', async () => {
    const count = await battle().serviceSeq(7).andRaw('{read_count} > ?', 990).getCount();
    const rows = await battle().raw('{seq} IN (?, ?)', 42, 43)
      .removeAllColumns().addRawColumnDoubled('({read_count} * ?)', 2)
      .orderByRaw('{seq} DESC').gets();
    return { count, rows: rows.values().map(r => [r.getSeq(), Number(r.getDoubled())]) };
  });
  await run('columns', async () => {
    const none = await new Service().connect(db).removeAllColumns().getBySeq(7);
    const added = await battle().removeAllColumns().addColumnName().addColumnReadCountAliasReadText("CONCAT('r', %s)").getBySeq(42);
    const removed = await new Service().connect(db).removeColumnName().getBySeq(7);
    return [none.toArray(), pick(added, 'seq', 'name', 'read_text'), removed.toArray()];
  });
  await run('joins', async () => {
    const service = new Service().on(s => s.gtSeq(0)).name('service-7');
    const rows = await battle()
      .removeAllColumns().addColumnName()
      .joinServiceSeqWithSeq(service)
      .isClose(false)
      .and(q => q.isDisplay(true).or(service))
      .orderBySeqAsc().limit(0, 2).gets();
    const member = new ServiceMember();
    const compared = await battle()
      .joinServiceMemberSeqWithSeq(member)
      .serviceSeq(7)
      .andSuccessCountLtSeq(member)
      .getCount();
    const left = await battle().leftJoinServiceModuleSeqWithSeq(new ServiceModule().aliasModule())
      .serviceSeq(7).orderBySeqAsc().limit(0, 1).gets();
    return { rows: rows.toArray(), compared, module: pick(left.first().getModule(), 'seq', 'name') };
  });
  await run('relations', async () => {
    const rows = await battle()
      .removeAllColumns().addColumnName().addColumnIsClose()
      .relation(new User().matchUserSeqWithSeq().aliasWriter()
        .relations(new Battle().matchSeqWithUserSeq().removeAllColumns().orderBySeqDesc().groupLimit(2)))
      .relation(new Service().matchServiceSeqWithSeq()
        .relations(new ServiceMember().matchSeqWithServiceSeq().removeAllColumns().orderBySeqAsc().groupLimit(2).keyNameUserSeq()))
      .relation(new ServiceModule().matchServiceModuleSeqWithSeq().possibleIsClose(true).parentNode())
      .serviceSeq(7).orderBySeqAsc().limit(0, 3).gets();
    return rows.toArray();
  });
  await run('relation_empty', async () => {
    const rows = await battle().relations(new ServiceMember().matchUserSeqWithUserSeq()).getsBySeq(-1);
    return rows.length;
  });
  await run('subqueries', async () => {
    const users = await new User().connect(db)
      .addColumnReadTotal(u => new Battle().sumReadCount().userSeqEqSeq(u).andServiceSeq(7))
      .seq(new Battle().addColumnUserSeq().serviceSeq(7).andGeReadCount(906))
      .orderBySeqAsc().gets();
    return users.values().map(u => [u.getSeq(), Number(u.getReadTotal())]);
  });
  await run('aggregates', async () => {
    const sum = await battle().serviceSeq(7).sumReadCount().getSum();
    const avg = await battle().serviceSeq(7).avgLikeCount().getAvg();
    const groups = await battle().serviceSeq(7).groupByIsClose().orderByIsCloseAsc().getsCount();
    const page = await battle().serviceSeq(7).removeAllColumns().orderBySeqAsc().getsPage(3, 4);
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
      battle().serviceSeq(7).andEqStartDt(orm.dayOfWeek(), 2),
      battle().serviceSeq(7).andStartDt(orm.year(), 2026),
      battle().serviceSeq(7).andGtStartDt(orm.daysAgo(36500)),
      battle().serviceSeq(7).andLtStartDt(orm.monthsLater(1200)),
    ]) counts.push(await q.getCount());
    const rows = await battle().removeAllColumns().addColumnStartDtAliasStartMonth(orm.month())
      .orderByStartDtAsc(orm.year()).orderBySeqAsc().getsBySeq([42, 43]);
    return { counts, months: rows.values().map(r => Number(r.getStartMonth())) };
  });
  await run('errors', async () => {
    const errs = [];
    const attempt = async fn => { try { await fn(); errs.push(null); } catch (error) { errs.push(code(error)); } };
    await attempt(() => battle().name('a').isClose(true).gets());
    await attempt(() => battle().name('a').and().gets());
    await attempt(() => battle().seq([]).gets());
    await attempt(() => new Battle().name('a').gets());
    await attempt(() => battle().forUpdate().gets());
    await attempt(() => battle().joinUserSeqWithSeq(new User().connect(db)).gets());
    await attempt(() => battle().limit(0, 1).getsPage(1, 10));
    await attempt(() => battle().relation(new User().matchUserSeqWithSeq().limit(0, 1)).getsBySeq(42));
    await attempt(() => battle().name('a').or(new User()).gets());
    return errs;
  });
  await run('get_query', async () => {
    const st = await battle().serviceSeq(7).andLkName('x').andAesHexEmail('user7@example.com').orderBySeqDesc().limit(0, 5).getQuery();
    return { sql: st.sql, binds: st.binds.map(norm) };
  });
  await run('aes_values', async () => {
    const row = await battle().removeAllColumns().addColumnAesHexEmail().addColumnAesHexPhone().getBySeq(42);
    const found = await battle().aesHexEmail('user42@example.com').getCount();
    return { row: row.toArray(), found };
  });
  await run('write_cycle', async () => {
    const start = new Date(Date.UTC(2026, 5, 1));
    const created = await battle()
      .setName('cycle').setUserSeq(1).setServiceSeq(999).setServiceModuleSeq(1).setServiceMemberSeq(1)
      .setStartDt(start).setEndDt(start).setPrice(12.5).setIp('10.0.0.1').setAesHexEmail('cycle@example.com')
      .setJsonSetting({ a: 1 }).setSerializeData({ k: 'v' })
      .newLabel('created')
      .create();
    const seq = created.getSeq();
    mask([seq]);
    const createdArray = created.toArray();
    createdArray.seq = '$SEQ';
    const loaded = await battle().addAllColumns().getBySeq(seq);
    mask([], loaded.getUpdatedTs());
    await loaded.setName('cycle-2').plusReadCount(3).update(true);
    let stale = null;
    try { await loaded.setName('stale').update(true); } catch (error) { stale = code(error); }
    const again = await battle().addAllColumns().getBySeq(seq);
    const updated = pick(again, 'name', 'read_count', 'price', 'ip', 'aes_hex_email', 'json_setting', 'serialize_data', 'start_dt');
    await again.delete();
    const gone = await caught(battle().getBySeq(seq));
    return { created: createdArray, updated, stale, deleted: gone };
  });
  await run('now_defaults', async () => {
    const start = new Date(Date.UTC(2026, 5, 1));
    const before = Date.now();
    const created = await battle()
      .setName('clock').setUserSeq(1).setServiceSeq(999).setServiceModuleSeq(1).setServiceMemberSeq(1)
      .setStartDt(start).setEndDt(start)
      .create();
    const seq = created.getSeq();
    mask([seq]);
    const loaded = await battle().getBySeq(seq);
    const createdTs = loaded.getCreatedTs();
    const updatedTs = loaded.getUpdatedTs();
    // The runner connects in +00:00, so the wall-clock text is UTC.
    const near = Math.abs(Date.parse(createdTs.replace(' ', 'T') + 'Z') - before) < 60_000;
    await loaded.delete();
    return { created_near_clock: near, created_equals_updated: createdTs === updatedTs };
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
        await db.utils().setLocal('app.actor', 'runner');
        events.push(await db.utils().local('app.actor'));
        throw boom;
      }, { retry: 0 });
    } catch (error) { failed = error; }
    events.push(failed === boom);
    events.push(await new Service().connect(db).name(['tx-outer', 'tx-inner']).getCount());
    return events;
  });
  await run('aes_status', async () => {
    const keyring = new AesKeyring(new Map([[1, 'bench-salt']]), 1);
    const status = await db.utils().aes().status(new Battle(), keyring);
    const versions = [...status.versions].map(([v, n]) => `${v}:${n}`).sort();
    return { current: status.current, pending: status.pending, versions: versions.join(',') };
  });

  await db.close();
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

main().catch(error => {
  console.error('runner_typescript:', error);
  process.exit(1);
});
