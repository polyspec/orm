// Model integration test. SQLite always runs; MySQL and PostgreSQL run when
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name a test database, e.g.
//   ORM_TEST_MYSQL_DSN='mysql://root@localhost/orm_ts_test?socket=/tmp/mysql.sock'
//   ORM_TEST_POSTGRES_DSN='postgres:///orm_ts_test?host=/tmp'
// The test drops and recreates the schema tables in those databases.
//
// Usage: node tests/typescript/model.mjs (after npm run typescript:build)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AesKeyring, Account, Battle, CORE, CompositeAccount, CompositeMembership, Db, Model, OrmError,
  Service, ServiceMember, ServiceModule, User, loadManifest, registerSchema, renderDDL,
} from '../../clients/typescript/dist/index.js';
import { buildManifest, encodeManifest } from '../../clients/typescript/dist/schema/build.js';
import { parseDiagram } from '../../clients/typescript/dist/schema/mermaid.js';

const require = createRequire(new URL('../../clients/typescript/package.json', import.meta.url));
const root = new URL('../..', import.meta.url).pathname;
const schemaPath = join(root, 'schema/schema.json');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-model-'));

let failures = 0;
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function code(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}
let current = '';

const manifestJson = await readFile(schemaPath, 'utf8');

/** Drops the schema tables, then installs the schema through the connection. */
async function install(dialect, dsn) {
  const drops = renderDDL(loadManifest(manifestJson), dialect).split('\n').filter(line => line.startsWith('DROP TABLE IF EXISTS ')).map(line => line.replace(/;$/, ''));
  const url = new URL(dsn);
  if (dialect === 'mysql') {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname, database: url.pathname.slice(1) });
    for (const s of drops) await conn.query(s);
    await conn.end();
  } else if (dialect === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.searchParams.get('host') ?? url.hostname, database: url.pathname.slice(1), user: url.username || undefined });
    await client.connect();
    await client.query('SET client_min_messages = warning');
    for (const s of drops) await client.query(`${s} CASCADE`);
    await client.end();
  }
  const db = await connect(dsn);
  try {
    check(await db.utils().schema().empty(), 'schema().empty() before install');
    await db.utils().schema().install(manifestJson);
    await db.utils().schema().install(manifestJson);
  } finally { await db.close(); }
}

const start = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const hours = h => new Date(start.getTime() + h * 3_600_000);

async function seed(db) {
  const service = await new Service().connect(db).setName('service').create();
  const users = [];
  for (const name of ['kim', 'lee', 'park']) users.push(await new User().connect(db).setName(name).create());
  const module = await new ServiceModule().connect(db).setServiceSeq(service.getSeq()).setName('module').create();
  const member = await new ServiceMember().connect(db).setServiceSeq(service.getSeq()).setUserSeq(users[0].getSeq()).create();
  const battles = [];
  for (const [i, name] of ['alpha', 'beta', 'gamma', 'delta'].entries()) {
    const b = new Battle().connect(db)
      .setName(name)
      .setUserSeq(users[i % 2].getSeq())
      .setServiceSeq(service.getSeq())
      .setServiceModuleSeq(module.getSeq())
      .setServiceMemberSeq(member.getSeq())
      .setStartDt(hours(i))
      .setEndDt(hours(48))
      .setReadCount(i * 10)
      .setIsClose(i % 2 === 1);
    if (i < 2) b.setCoverUrl(`cover-${name}`);
    battles.push(await b.create());
  }
  return { service, users, module, member, battles };
}

const names = rows => rows.values().map(b => b.getName()).join(',');

async function conditions(db) {
  const f = await seed(db);
  const svc = f.service.getSeq();
  let rows = await new Battle().connect(db).serviceSeq(svc).andIsClose(false).or().isClose(true).orderBySeqAsc().gets();
  check(names(rows) === 'alpha,beta,gamma,delta', `connectors: ${names(rows)}`);
  rows = await new Battle().connect(db).serviceSeq(svc)
    .and(q => q.geReadCount(10).andLtReadCount(30).or().name('alpha'))
    .orderByReadCountDescAndSeqAsc().gets();
  check(names(rows) === 'gamma,beta,alpha', `group: ${names(rows)}`);
  rows = await new Battle().connect(db).getsBySeqAndNeName([f.battles[0].getSeq(), f.battles[1].getSeq()], 'beta');
  check(names(rows) === 'alpha', `getsBy list: ${names(rows)}`);
  check(await new Battle().connect(db).coverUrl(null).getCount() === 2, 'null');
  check(await new Battle().connect(db).neCoverUrl(null).andLkName('lph').getCount() === 1, 'not null and like');
  check(await new Battle().connect(db).betweenReadCount([10, 20]).getCount() === 2, 'between');
  check(await new Battle().connect(db).gtStartDt(new Date(start.getTime() + 90 * 60_000)).getCount() === 2, 'time compare');
  const one = await new Battle().connect(db).getByName('gamma');
  check(one !== null && one.getReadCount() === 20, 'getBy');
  check(await new Battle().connect(db).getByName('missing') === null, 'get without a row returns null');
  const q = new Battle().connect(db).serviceSeq(svc);
  const first = await q.getCountByIsClose(true);
  const second = await q.getCount();
  check(first === 2 && second === 4, `terminal changed the model: ${first} ${second}`);
  check(await new Battle().connect(db).raw('{read_count} >= ?', 20).getCount() === 2, 'raw');
  check(await code(new Battle().connect(db).name('a').isClose(true).gets()) === 'CONFIG', 'missing connector');
  check(await code(new Battle().connect(db).name('a').and().gets()) === 'CONFIG', 'dangling connector');
  check(await code(new Battle().connect(db).seq([]).gets()) === 'EMPTY_IN', 'empty list');
  const st = await new Battle().connect(db).name('alpha').getQuery();
  check(st.sql.includes('name') && st.binds.length === 1, `getQuery: ${JSON.stringify(st)}`);
  check(await code(new Battle().name('alpha').gets()) === 'CONFIG', 'no connection');
}

async function joinsAndRelations(db, dsn) {
  const f = await seed(db);
  const author = new User().on(u => u.neName('nobody')).name('kim');
  const rows = await new Battle().connect(db)
    .leftJoinUserSeqWithSeq(author)
    .serviceSeq(f.service.getSeq())
    .and(q => q.name('delta').or(author))
    .orderBySeqAsc().gets();
  check(names(rows) === 'alpha,gamma,delta', `placed join conditions: ${names(rows)}`);
  check(rows.first().getUserModel()?.getName() === 'kim', 'join result');
  const member = new ServiceMember();
  const cmp = await new Battle().connect(db).joinServiceMemberSeqWithSeq(member).readCountGtSeq(member).getCount();
  check(cmp === 3, `column comparison with a joined model: ${cmp}`);

  const loaded = await new Battle().connect(db)
    .relation(new User().matchUserSeqWithSeq().aliasWriter())
    .relations(new ServiceMember().matchServiceSeqWithServiceSeq().aliasMembers())
    .relation(new ServiceModule().matchServiceModuleSeqWithSeq())
    .orderBySeqAsc().gets();
  const b = loaded.first();
  check(b.getWriter()?.getName() === 'kim', 'relation alias');
  check(b.getMembers().length === 1 && b.getServiceModuleModel().getName() === 'module', 'relations');
  const limited = await new User().connect(db)
    .relations(new Battle().matchSeqWithUserSeq().orderBySeqDesc().groupLimit(1))
    .orderBySeqAsc().gets();
  const got = limited.first().getBattleModels();
  check(got.length === 1 && got.first().getName() === 'gamma', `groupLimit: ${names(got)}`);
  const other = await connect(dsn);
  try {
    const external = await new Battle().connect(db)
      .relation(new User().connect(other).matchUserSeqWithSeq().aliasOwner())
      .getByName('beta');
    check(external.getOwner()?.getName() === 'lee', 'relation on another connection');
  } finally { await other.close(); }
  check(await code(new Battle().connect(db).joinUserSeqWithSeq(new User().connect(db)).gets()) === 'CONFIG', 'join child with connection');
  check(await code(new Battle().connect(db).name('a').or(new User()).gets()) === 'CONFIG', 'unjoined model placement');
  const array = b.toArray();
  check(array.writer !== null && array.writer !== undefined && array.name === 'alpha', `toArray: ${JSON.stringify(array)}`);
}

async function columnsAndSubqueries(db) {
  const f = await seed(db);
  const users = await new User().connect(db)
    .addColumnReadTotal(u => new Battle().sumReadCount().userSeqEqSeq(u))
    .addRawColumnDoubled('({seq} * ?)', 2)
    .addColumnNameAliasUpperName('UPPER(%s)')
    .seq(new Battle().addColumnUserSeq().isClose(false))
    .orderBySeqAsc().gets();
  check(users.length === 1, `subquery IN: ${users.length}`);
  const u = users.first();
  check(Number(u.getReadTotal()) === 20 && Number(u.getDoubled()) === 2 * u.getSeq() && u.getUpperName() === 'KIM', `added columns: ${u.getReadTotal()} ${u.getDoubled()} ${u.getUpperName()}`);
  const sum = await new Battle().connect(db).serviceSeq(f.service.getSeq()).sumReadCount().getSum();
  const avg = await new Battle().connect(db).serviceSeq(f.service.getSeq()).avgReadCount().getAvg();
  check(sum === 60 && avg === 15, `aggregates: ${sum} ${avg}`);
  check((await new Battle().connect(db).groupByIsClose().getsCount()).length === 2, 'getsCount');
  const page = await new Battle().connect(db).orderBySeqAsc().getsPage(2, 3);
  check(page.totalCount === 4 && page.totalPages === 2 && page.items.length === 1 && page.items.first().getName() === 'delta', 'page');
  const keyed = await new Battle().connect(db).keyNameName().gets();
  check(keyed.get('beta') !== undefined, 'keyName');
  const fetched = await new Battle().connect(db).fetchKey(b => `k${b.getSeq()}`).fetchValue(b => b.getName()).orderBySeqAsc().gets();
  check(fetched.fetched(`k${f.battles[0].getSeq()}`) === 'alpha', 'fetchKey and fetchValue');
  for (const a of [10, 11]) for (const tenant of [1, 2]) await new CompositeAccount().connect(db).setTenantId(tenant).setAccountId(a).setName('n').create();
  const inserted = await new CompositeMembership().connect(db).creates([
    new CompositeMembership().setTenantId(1).setAccountId(10).setRole('owner'),
    new CompositeMembership().setTenantId(1).setAccountId(11).setRole('member'),
    new CompositeMembership().setTenantId(2).setAccountId(10).setRole('member'),
  ]);
  check(inserted === 3, `creates: ${inserted}`);
  const pairs = await new CompositeMembership().connect(db).tupleTenantIdWithAccountId([[1, 10], [2, 10]]).getCount();
  check(pairs === 2, `tuple: ${pairs}`);
}

async function writes(db) {
  const f = await seed(db);
  const b = await new Battle().connect(db).getBySeq(f.battles[0].getSeq());
  await b.setName('renamed').plusReadCount(5).update(true);
  const again = await new Battle().connect(db).getBySeq(b.getSeq());
  check(again.getName() === 'renamed' && again.getReadCount() === 5, `update: ${again.getName()} ${again.getReadCount()}`);
  check(await code(b.setName('stale').update(true)) === 'CONFIG', 'optimistic update without a fresh version');
  await again.setName('again').update();
  await b.setName('x').update();
  const item = await new Account().connect(db).setName('acc').newLabel('shown').create();
  check(item.getLabel() === 'shown' && item.toArray().label === 'shown', `new value: ${JSON.stringify(item.toArray())}`);
  const saved = await new Account().connect(db).setSeq(item.getSeq()).setName('saved').save();
  check(saved.getName() === 'saved' && (await new Account().connect(db).getBySeq(item.getSeq())).getName() === 'saved', 'save as update');
  await (await new Battle().connect(db).getBySeq(f.battles[3].getSeq())).delete();
  check(await new Battle().connect(db).getCount() === 3, 'delete');
  await (await new Battle().connect(db).isClose(true).gets()).delete();
  check(await new Battle().connect(db).getCount() === 2, 'collection delete');
  await new CompositeAccount().connect(db).setTenantId(9).setAccountId(9).setName('first').create();
  await new CompositeAccount().connect(db).setTenantId(9).setAccountId(9).setName('first')
    .duplication(new CompositeAccount().setName('second')).create();
  check((await new CompositeAccount().connect(db).getByTenantIdAndAccountId(9, 9)).getName() === 'second', 'duplication');
}

async function transactions(db) {
  const boom = new Error('boom');
  let err = null;
  try { await db.transaction(async () => { await new User().setName('rolled back').create(); throw boom; }); } catch (error) { err = error; }
  check(err === boom && await new User().connect(db).getCount() === 0, 'rollback');
  await db.transaction(async () => {
    await new User().setName('outer').create();
    let inner = null;
    try { await db.transaction(async () => { await new User().setName('inner').create(); throw boom; }); } catch (error) { inner = error; }
    check(inner === boom, 'savepoint error');
    check(await new User().getCount() === 1, 'savepoint rollback');
    await new User().name('outer').forUpdate().gets();
    await db.utils().lock('users');
    await db.utils().setLocal('app.actor', 'tester');
    check(await db.utils().local('app.actor') === 'tester', 'local');
    check(await code(db.utils().local('app.missing')) === 'NO_ROWS', 'missing local');
    const concurrent = await Promise.allSettled([new User().getCount(), new User().getCount()]);
    check(concurrent.some(r => r.status === 'rejected' && r.reason instanceof OrmError && r.reason.code === 'CONFIG'), 'concurrent use of one transaction');
  }, { isolation: 'read_committed', retry: 0 });
  check(await new User().connect(db).getCount() === 1, 'commit');
  check(await code(new User().connect(db).forUpdate().gets()) === 'CONFIG', 'lock outside a transaction');
  check(await code(db.utils().lock('x')) === 'CONFIG', 'lock utility outside a transaction');
  let attempts = 0;
  await db.transaction(async () => {
    attempts++;
    if (attempts < 3) throw new OrmError('DEADLOCK', 'retry');
  });
  check(attempts === 3, `retry: ${attempts}`);
  check(await code(db.transaction(async () => { throw new OrmError('DEADLOCK', 'retry'); }, { retry: 0 })) === 'DEADLOCK', 'retry disabled');
  check(!(await db.utils().schema().empty()), 'schema().empty() on an installed schema');
  check(db.utils().stats().openConnections >= 1, `stats: ${JSON.stringify(db.utils().stats())}`);
}

async function aesRotation(db) {
  const f = await seed(db);
  const b = await new Battle().connect(db).getBySeq(f.battles[0].getSeq());
  await b.setAesHexEmail('person@example.com').update();
  const found = await new Battle().connect(db).aesHexEmail('person@example.com').getBySeq(b.getSeq());
  check(found?.getAesHexEmail() === 'person@example.com', 'aes round trip and blind index');
  const keyring = new AesKeyring(new Map([[1, 'test-aes-key'], [2, 'next-aes-key']]), 2);
  let status = await db.utils().aes().status(new Battle(), keyring);
  check(status.total === 4 && status.pending === 4, `status: ${JSON.stringify(status)}`);
  const rotated = await db.utils().aes().rotate(new Battle(), keyring);
  check(rotated === 4, `rotated ${rotated}`);
  status = await db.utils().aes().status(new Battle(), keyring);
  check(status.pending === 0, `after rotation: ${JSON.stringify(status)}`);
}

function connect(dsn) {
  return Db.connect(dsn, schemaPath, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key' });
}

/**
 * Writes a wall-clock value and reads it back in the connection time zone, and
 * checks that the clock default and an equality filter use the same zone.
 */
async function connectionTimeZone(db, offsetMinutes) {
  const f = await seed(db);
  const midnight = new Date(Date.UTC(2026, 0, 2) - offsetMinutes * 60_000);
  const before = Date.now();
  const created = await new Battle().connect(db)
    .setName('zone').setUserSeq(f.users[0].getSeq()).setServiceSeq(f.service.getSeq())
    .setServiceModuleSeq(f.module.getSeq()).setServiceMemberSeq(f.member.getSeq())
    .setStartDt(midnight).setEndDt('2026-01-03 00:00:00').create();
  const row = await new Battle().connect(db).getBySeq(created.getSeq());
  check(row?.getStartDt() === '2026-01-02 00:00:00.000000', `start_dt ${row?.getStartDt()}`);
  const wall = text => Date.parse(`${text.replace(' ', 'T').slice(0, 23)}Z`) - offsetMinutes * 60_000;
  check(row !== null && Math.abs(wall(row.getCreatedTs()) - before) < 60_000, `created_ts ${row?.getCreatedTs()} at ${new Date(before).toISOString()}`);
  check(await new Battle().connect(db).startDt(midnight).getCount() === 1, 'equality filter with an instant');
  check(await new Battle().connect(db).startDt('2026-01-02 00:00:00').getCount() === 1, 'equality filter by text');
  check(await new Battle().connect(db).startDt('2026-01-02T00:00:00.0').getCount() === 1, 'equality filter by text with fraction');
  check(await new Battle().connect(db).startDt(['2026-01-02 00:00:00', '2026-01-03 00:00:00']).getCount() === 1, 'in filter by text');
  check(await new Battle().connect(db).betweenStartDt(['2026-01-02 00:00:00', '2026-01-02 00:00:00.5']).getCount() === 1, 'between filter by text');
  if (db.driver === 'sqlite') {
    check(await code(new Battle().connect(db).startDt('2026-01-02').getCount()) === 'CODEC_ENCODE', 'date-only datetime text');
  }
}

/**
 * Inserts and reads more values than SQLite binds in one statement: the
 * inserts and the root IN list are split, duplicate IN values are read once,
 * and a shape that a merge would change is rejected.
 */
async function bindLimitSplitting(db) {
  const n = 1200;
  const names = [];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const name = `chunk-${String(i).padStart(4, '0')}`;
    rows.push(new Service().setName(name));
    names.push(name);
  }
  check(await new Service().connect(db).creates(rows) === n, 'inserted rows');
  names.push(...names.slice(0, 200));
  for (let i = 0; i < 100; i++) names.push(`missing-${i}`);
  const found = await new Service().connect(db).name(names).gets();
  check(found.length === n, `found ${found.length} rows`);
  check(await new Service().connect(db).name(names).getCount() === n, 'count of split IN');
  if (db.driver === 'sqlite') {
    check(await code(new Service().connect(db).name(names).limit(0, 10).gets()) === 'IR_INVALID', 'limited split');
  }
}

/** A MySQL install inside a transaction returns CONFIG: schema statements commit implicitly. */
async function mysqlInstallInsideTransaction(db) {
  let inside = null;
  await db.transaction(async () => { inside = await code(db.utils().schema().install(manifestJson)); });
  check(inside === 'CONFIG', `install inside a transaction: ${inside}`);
}

/** A manifest built from Mermaid and a model class for each of its entities. */
function auditSchema(source) {
  const manifest = buildManifest([parseDiagram(source)]);
  const entities = new Map(Object.values(manifest.entities).map(e => [e.name, {
    name: e.name, table: e.table, pk: e.pk, auto: e.auto, fulltext: [],
    columns: Object.fromEntries(e.columns.map(c => [c.name, { type: c.type, nullable: c.nullable, styles: c.styles }])),
  }]));
  const set = { hash: manifest.schema_hash, entities };
  registerSchema(set);
  const models = {};
  for (const name of entities.keys()) {
    const model = class extends Model {};
    model.entity = { schema: entities.get(name), set, create: core => new model(core) };
    models[name] = model;
  }
  return { json: encodeManifest(manifest), models };
}

/**
 * Installs log tables and, from a second manifest, audited tables, and writes
 * inside a transaction that names its operation with setLocal; PostgreSQL and
 * SQLite use schema-qualified tables.
 */
async function auditTriggers(dialect, dsn) {
  const prefix = dialect === 'mysql' ? '' : 'app.';
  const logs = auditSchema('erDiagram\n'
    + '  audit_operation {\n    bigint seq PK "auto"\n    varchar(36) operation_uuid UK\n  }\n'
    + '  audit_change {\n    bigint seq PK "auto"\n    bigint operation_seq\n    varchar(16) change_kind\n    varchar(36) site_ref "?"\n'
    + '    varchar(191) table_label\n    jsontext entity_ref\n    jsontext before_value\n    jsontext after_value\n  }\n'
    + (prefix === '' ? '' : '  %% orm:table entity=audit_operation name=app.audit_operation\n  %% orm:table entity=audit_change name=app.audit_change\n'));
  // The audited manifest writes into log tables that only the first manifest declares.
  const items = auditSchema('erDiagram\n'
    + '  audit_item {\n    bigint seq PK "auto"\n    varchar(36) site_ref\n    varchar(191) title\n  }\n'
    + (prefix === '' ? '' : '  %% orm:table entity=audit_item name=app.audit_item\n')
    + `  %% orm:audit_log operation=${prefix}audit_operation(seq, operation_uuid) context=app.operation_id change=${prefix}audit_change(operation_seq, change_kind, site_ref, table_label, entity_ref, before_value, after_value)\n`
    + '  %% orm:audit entity=audit_item mode=changes site=site_ref\n');
  await dropAuditTables(dialect, dsn);
  const db = await connect(dsn);
  try {
    for (const json of [logs.json, items.json, items.json]) await db.utils().schema().install(json);
    const { audit_operation: AuditOperation, audit_change: AuditChange } = logs.models;
    const { audit_item: AuditItem } = items.models;
    const item = (site, title) => { const m = new AuditItem(); m[CORE].setValue('site_ref', site); m[CORE].setValue('title', title); return m; };
    let message = '';
    try { await db.transaction(async () => { await item('s1', 'a').create(); }, { retry: 0 }); } catch (error) { message = String(error.message); }
    check(message.includes('audit operation context is required'), `write without an operation: ${message}`);
    let seq;
    await db.transaction(async () => {
      const op = new AuditOperation();
      op[CORE].setValue('operation_uuid', 'op-1');
      await op.create();
      await db.utils().setLocal('app.operation_id', 'op-1');
      const created = await item('s1', 'a').create();
      seq = created[CORE].column('seq');
      const changed = new AuditItem();
      changed[CORE].setValue('seq', seq);
      changed[CORE].setValue('title', 'b');
      await changed.update();
    }, { retry: 0 });
    const query = new AuditChange().connect(db).addAllColumns();
    query[CORE].orderBy('seq', false, []);
    const rows = [...(await query.gets()).values()];
    const value = (row, column) => row[CORE].column(column);
    const plain = v => JSON.parse(JSON.stringify(v, (_, x) => x instanceof Map ? Object.fromEntries(x) : x));
    check(rows.map(r => value(r, 'change_kind')).join(',') === 'INSERT,UPDATE', `change kinds ${rows.map(r => value(r, 'change_kind'))}`);
    for (const row of rows) {
      check(Number(value(row, 'operation_seq')) === 1 && value(row, 'site_ref') === 's1' && value(row, 'table_label') === `${prefix}audit_item`, 'change row');
      check(JSON.stringify(plain(value(row, 'entity_ref'))) === JSON.stringify({ seq: Number(seq) }), `entity key ${JSON.stringify(plain(value(row, 'entity_ref')))}`);
    }
    check(JSON.stringify(plain(value(rows[1], 'before_value'))) === '{"title":"a"}' && JSON.stringify(plain(value(rows[1], 'after_value'))) === '{"title":"b"}', 'update values');
  } finally { await db.close(); }
  await dropAuditTables(dialect, dsn);
}

async function dropAuditTables(dialect, dsn) {
  const url = new URL(dsn);
  if (dialect === 'mysql') {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname, database: url.pathname.slice(1) });
    for (const table of ['audit_item', 'audit_change', 'audit_operation']) await conn.query(`DROP TABLE IF EXISTS ${table}`);
    await conn.end();
  } else if (dialect === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.searchParams.get('host') ?? url.hostname, database: url.pathname.slice(1), user: url.username || undefined });
    await client.connect();
    await client.query('SET client_min_messages = warning');
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
    await client.end();
  }
}

const zones = [['+00:00', 0], ['+09:00', 540], ['-05:30', -330], ['Asia/Seoul', 540]];

const targets = [['sqlite', `sqlite://${join(work, 'model.sqlite')}?_pragma=busy_timeout(5000)`]];
if (process.env.ORM_TEST_MYSQL_DSN) targets.push(['mysql', process.env.ORM_TEST_MYSQL_DSN]);
if (process.env.ORM_TEST_POSTGRES_DSN) targets.push(['postgres', process.env.ORM_TEST_POSTGRES_DSN]);
const cases = { conditions, joinsAndRelations, columnsAndSubqueries, writes, transactions, aesRotation, bindLimitSplitting };

try {
  for (const [dialect, dsn] of targets) {
    for (const [name, fn] of Object.entries(cases)) {
      current = `${dialect}/${name}`;
      if (dialect === 'sqlite') await rm(join(work, 'model.sqlite'), { force: true });
      await install(dialect, dsn);
      const db = await connect(dsn);
      try { await fn(db, dsn); } catch (error) { failures++; console.error(`FAIL ${current}:`, error); } finally { await db.close(); }
      console.log(`${current} done`);
    }
  }
  for (const [dialect, dsn] of targets) {
    current = `${dialect}/poolSize`;
    const sized = await Db.connect(dsn, schemaPath, { poolSize: 3 });
    try {
      // The SQLite driver holds one connection, so the size applies to the pooled drivers.
      const want = dialect === 'sqlite' ? 1 : 3;
      check(sized.utils().stats().maxOpenConnections === want, `configured pool size ${sized.utils().stats().maxOpenConnections}`);
      check(await code(Db.connect(dsn, schemaPath, { poolSize: -1 })) === 'CONFIG', 'negative pool size');
    } catch (error) { failures++; console.error(`FAIL ${current}:`, error); } finally { await sized.close(); }
    console.log(`${current} done`);
  }
  for (const [dialect, dsn] of targets) {
    current = `${dialect}/statementTimeout`;
    if (dialect === 'sqlite') await rm(join(work, 'model.sqlite'), { force: true });
    await install(dialect, dsn);
    check(await code(Db.connect(dsn, schemaPath, { statementTimeoutMs: -1 })) === 'CONFIG', 'negative statement timeout');
    // MySQL bounds SELECT statements, PostgreSQL bounds every statement, and
    // SQLite has no session timeout.
    const slow = { mysql: 'SLEEP(5) = 0', postgres: 'pg_sleep(5) IS NULL' }[dialect];
    if (slow !== undefined) {
      const bounded = await Db.connect(dsn, schemaPath, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key', statementTimeoutMs: 200 });
      try {
        await seed(bounded);
        check(await code(new Battle().connect(bounded).raw(slow).getCount()) === 'CANCELED', 'a statement past the timeout');
      } catch (error) { failures++; console.error(`FAIL ${current}:`, error); } finally { await bounded.close(); }
    }
    console.log(`${current} done`);
  }
  for (const [dialect, dsn] of targets) {
    current = `${dialect}/cancellation`;
    if (dialect === 'sqlite') await rm(join(work, 'model.sqlite'), { force: true });
    await install(dialect, dsn);
    const db = await connect(dsn);
    try {
      // The slow condition is evaluated per row, so the table holds rows.
      await seed(db);
      const slow = { mysql: 'SLEEP(5) = 0', postgres: 'pg_sleep(5) IS NULL' }[dialect];
      const before = new AbortController();
      before.abort();
      check(await code(new Battle().connect(db.withSignal(before.signal)).getCount()) === 'CANCELED', 'a signal aborted before the statement');
      if (slow !== undefined) {
        const running = new AbortController();
        const timer = setTimeout(() => running.abort(), 300);
        const started = Date.now();
        check(await code(new Battle().connect(db.withSignal(running.signal)).raw(slow).getCount()) === 'CANCELED', 'a statement cancelled while it runs');
        check(Date.now() - started < 4000, 'the cancelled statement returned before it ended');
        clearTimeout(timer);
      }
      check(typeof await new Battle().connect(db).getCount() === 'number', 'the connection is usable after a cancellation');
    } catch (error) { failures++; console.error(`FAIL ${current}:`, error); } finally { await db.close(); }
    console.log(`${current} done`);
  }
  for (const [dialect, dsn] of targets) {
    current = `${dialect}/auditTriggers`;
    if (dialect === 'sqlite') await rm(join(work, 'model.sqlite'), { force: true });
    try { await auditTriggers(dialect, dsn); } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
    console.log(`${current} done`);
  }
  for (const [dialect, dsn] of targets.filter(t => t[0] === 'mysql')) {
    current = `${dialect}/installInsideTransaction`;
    await install(dialect, dsn);
    const db = await connect(dsn);
    try { await mysqlInstallInsideTransaction(db); } catch (error) { failures++; console.error(`FAIL ${current}:`, error); } finally { await db.close(); }
    console.log(`${current} done`);
  }
  for (const [dialect, base] of targets) {
    for (const [zone, offset] of zones) {
      current = `${dialect}/connectionTimeZone/${zone}`;
      if (dialect === 'sqlite') await rm(join(work, 'model.sqlite'), { force: true });
      const dsn = `${base}${base.includes('?') ? '&' : '?'}timezone=${encodeURIComponent(zone)}`;
      await install(dialect, dsn);
      const db = await connect(dsn);
      try { await connectionTimeZone(db, offset); } catch (error) { failures++; console.error(`FAIL ${current}:`, error); } finally { await db.close(); }
      console.log(`${current} done`);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript model test: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`typescript model test passed (${targets.map(t => t[0]).join(', ')})`);
