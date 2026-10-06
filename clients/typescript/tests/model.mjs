// Model integration test on SQLite, MySQL and PostgreSQL. ORM_TEST_MYSQL_DSN
// and ORM_TEST_POSTGRES_DSN must be set, e.g.
//   ORM_TEST_MYSQL_DSN='mysql://root@localhost/orm_ts_test?socket=/tmp/mysql.sock'
//   ORM_TEST_POSTGRES_DSN='postgres:///orm_ts_test?host=/tmp'
// Every case that installs the schema or checks an empty database runs on a
// case database of its own (case-database.mjs), created on those servers and
// dropped when the case ends; the databases the DSNs name are not changed.
//
// Usage: node clients/typescript/tests/model.mjs (after npm run typescript:build)
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Account, AesKeyring, Author, CORE, CompositeAccount, CompositeMembership, Db, Model, OrmError, SCHEMA, Service,
  ServiceMember, ServiceRegion, StyledValue, User, connect as connectBench, dbspecManifest, parseDbspec,
  registerModel,
} from '../dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { DATABASE, sections } from '../../../tests/testcase.mjs';
import { caseName, mysqlConnection, postgresClient, relatedDsn, withCaseDatabase } from './case-database.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const root = new URL('../../..', import.meta.url).pathname;
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 4 || args[0] !== '--case' || args[1] !== 'styledStates' || args[2] !== '--dialect' || !['sqlite', 'mysql', 'postgres'].includes(args[3]))) {
  throw new Error('usage: model.mjs [--case styledStates --dialect sqlite|mysql|postgres]');
}
const selectedCase = args.length === 0 ? undefined : args[1];
const work = await mkdtemp(join(tmpdir(), 'orm-ts-model-'));

let failures = 0;
/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function code(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}
let current = '';
// 각 구역은 case 하나다. 기한은 DATABASE다: 구역은 schema를 설치하고 statement 수백 개 이하를
// 실행한다.
const caseLog = sections();
let caseFailures = 0;
function begin(name) {
  current = name;
  caseFailures = failures;
  caseLog.begin(`model/${name}`, DATABASE);
}
function end() {
  caseLog.end(failures > caseFailures ? `${failures - caseFailures} check(s) failed; each FAIL line above names one` : undefined);
}

/**
 * Returns after the replica has applied every change the primary committed
 * before the call. On PostgreSQL a transaction with
 * synchronous_commit=remote_apply that writes WAL, here a transactional
 * logical message, commits after the standby has applied it; a transaction
 * that writes no WAL besides its commit record does not wait. On MySQL
 * SOURCE_POS_WAIT on the replica waits for the binary log position of the
 * primary.
 */
async function awaitReplica(dialect, primary, replica) {
  if (dialect === 'postgres') {
    const client = postgresClient(primary);
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = remote_apply');
      const mode = (await client.query("SELECT current_setting('synchronous_commit') AS mode, pg_logical_emit_message(true, 'orm-test-barrier', '')")).rows[0].mode;
      if (mode !== 'remote_apply') throw new Error(`synchronous_commit of the barrier transaction is ${mode}`);
      await client.query('COMMIT');
    } finally { await client.end(); }
    return;
  }
  // replica에 case database가 아직 없을 수 있으므로 두 연결 모두 database 없이 연다. 한 연결이
  // 실패해도 열린 연결은 닫는다. 열린 연결은 test process가 끝나지 못하게 한다.
  const source = await mysqlConnection(primary, null);
  try {
    const target = await mysqlConnection(replica, null);
    try {
      const [[{ current }]] = await target.query('SELECT DATABASE() AS current');
      if (current !== null) throw new Error(`the replica wait connection opened database ${current}`);
      const [[status]] = await source.query('SHOW BINARY LOG STATUS');
      // 기한은 60초다: replica는 병렬로 실행하는 모든 client의 쓰기를 차례로 적용하므로, 4 vCPU Linux
      // runner에서 10초 안에 primary 위치에 닿지 못했다.
      const [[{ waited }]] = await target.query('SELECT SOURCE_POS_WAIT(?, ?, 60) AS waited', [status.File, status.Position]);
      if (waited === null || Number(waited) < 0) throw new Error(`the replica did not reach ${status.File}:${status.Position}`);
    } finally { await target.end(); }
  } finally { await source.end(); }
}

/**
 * Opens a connection to the primary and one to its replica side by side. A
 * model uses the connection it is connected to and no other, and a model
 * without a connection inside a transaction uses the transaction.
 */
async function primaryAndReplica(dialect, primary, replica) {
  await install(primary);
  const master = await connect(primary);
  let slave1;
  try {
    const name = `replica-${process.hrtime.bigint()}`;
    await new User().connect(master).setName(name).create();
    await awaitReplica(dialect, primary, replica);
    slave1 = await connect(replica);
    check(await new User().connect(slave1).name(name).getCount() === 1, 'the replica reads the row written through the primary');
    check(await code(new User().connect(slave1).setName(`${name}-replica`).create()) === 'READ_ONLY', 'a write through the replica connection is rejected');
    check(await new User().connect(master).name(`${name}-replica`).getCount() === 0, 'a write through the replica connection does not reach the primary');
    // A row read through the replica is written through the primary.
    await (await new User().connect(slave1).name(name).get()).connect(master).setName(`${name}-renamed`).update();
    await master.transaction(async () => {
      await new User().setName(`${name}-tx`).create();
      check(await new User().connect(master).name(`${name}-tx`).getCount() === 1, 'the primary connection inside its transaction');
      check(await new User().connect(slave1).name(`${name}-tx`).getCount() === 0, 'the replica connection reads no uncommitted row');
    });
    await awaitReplica(dialect, primary, replica);
    check(await new User().connect(slave1).name([`${name}-renamed`, `${name}-tx`]).getCount() === 2, 'the replica reads the committed rows');
  } finally {
    await master.close();
    if (slave1) await slave1.close();
  }
}

/** Runs statements on the PostgreSQL database of a DSN through the pg driver. */
async function postgres(dsn, statements) {
  const client = postgresClient(dsn);
  await client.connect();
  try {
    await client.query('SET client_min_messages = warning');
    for (const s of statements) await client.query(s);
  } finally { await client.end(); }
}

/** Installs the schema twice through a connection to the new case database, which must be empty first. */
async function install(dsn) {
  const db = await connect(dsn);
  try {
    check(await db.utils().schema().empty(), 'schema().empty() before install');
    await db.utils().schema().install(SCHEMA);
    await db.utils().schema().install(SCHEMA);
  } finally { await db.close(); }
}

/**
 * Checks schema().empty() on a new case database, with an empty PostgreSQL
 * schema other than public, and with the installed tables.
 */
async function schemaEmpty(dialect, dsn) {
  const db = await connect(dsn);
  try {
    check(await db.utils().schema().empty(), 'a database without tables');
    if (dialect === 'postgres') {
      await postgres(dsn, ['CREATE SCHEMA unowned_empty']);
      try {
        check(!(await db.utils().schema().empty()), 'an empty schema other than public');
      } finally { await postgres(dsn, ['DROP SCHEMA unowned_empty']); }
      check(await db.utils().schema().empty(), 'the empty schema dropped');
    }
    await db.utils().schema().install(SCHEMA);
    check(!(await db.utils().schema().empty()), 'installed tables');
  } finally { await db.close(); }
}

const start = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const hours = h => new Date(start.getTime() + h * 3_600_000);

async function seed(db) {
  const service = await new Service().connect(db).setName('service').create();
  const users = [];
  for (const name of ['kim', 'lee', 'park']) users.push(await new User().connect(db).setName(name).create());
  const module = await new ServiceRegion().connect(db).setServiceSeq(service.getSeq()).setName('module').create();
  const member = await new ServiceMember().connect(db).setServiceSeq(service.getSeq()).setUserSeq(users[0].getSeq()).create();
  const authors = [];
  for (const [i, name] of ['alpha', 'beta', 'gamma', 'delta'].entries()) {
    const b = new Author().connect(db)
      .setName(name)
      .setUserSeq(users[i % 2].getSeq())
      .setServiceSeq(service.getSeq())
      .setServiceRegionSeq(module.getSeq())
      .setServiceMemberSeq(member.getSeq())
      .setStartDt(hours(i))
      .setEndDt(hours(48))
      .setReadCount(i * 10)
      .setIsClose(i % 2 === 1);
    if (i < 2) b.setPhotoUrl(`cover-${name}`);
    authors.push(await b.create());
  }
  return { service, users, module, member, authors };
}

const names = rows => rows.values().map(b => b.getName()).join(',');

/**
 * 다른 연결의 열린 transaction에서 table의 모든 행을 갱신해 그 행의 lock을 잡는다(MySQL, PostgreSQL).
 * 돌려준 함수는 그 transaction을 rollback하고 연결을 닫으며, 두 번째 호출은 아무것도 하지 않는다.
 */
async function holdRows(dialect, dsn, table) {
  if (dialect === 'mysql') {
    const connection = await mysqlConnection(dsn);
    await connection.query('START TRANSACTION');
    await connection.query(`UPDATE \`${table}\` SET \`seq\` = \`seq\``);
    let released = false;
    return async () => { if (released) return; released = true; await connection.query('ROLLBACK'); await connection.end(); };
  }
  const client = postgresClient(dsn);
  await client.connect();
  await client.query('BEGIN');
  await client.query(`UPDATE "${table}" SET "seq" = "seq"`);
  let released = false;
  return async () => { if (released) return; released = true; await client.query('ROLLBACK'); await client.end(); };
}

/** connection의 transaction에서 Model의 행을 FOR UPDATE로 읽는다. 다른 연결이 그 행을 잡고 있으면 기다린다. */
const lockedRead = (db, Model) => db.transaction(async () => { await new Model().forUpdate().get(); }, { retry: 0 });

async function conditions(db) {
  const f = await seed(db);
  const svc = f.service.getSeq();
  let rows = await new Author().connect(db).serviceSeq(svc).andIsClose(false).or().isClose(true).orderBySeqAsc().gets();
  check(names(rows) === 'alpha,beta,gamma,delta', `connectors: ${names(rows)}`);
  rows = await new Author().connect(db).serviceSeq(svc)
    .and(q => q.geReadCount(10).andLtReadCount(30).or().name('alpha'))
    .orderByReadCountDescAndSeqAsc().gets();
  check(names(rows) === 'gamma,beta,alpha', `group: ${names(rows)}`);
  rows = await new Author().connect(db).getsBySeqAndNeName([f.authors[0].getSeq(), f.authors[1].getSeq()], 'beta');
  check(names(rows) === 'alpha', `getsBy list: ${names(rows)}`);
  check(await new Author().connect(db).photoUrl(null).getCount() === 2, 'null');
  check(await new Author().connect(db).nePhotoUrl(null).andLkName('lph').getCount() === 1, 'not null and like');
  check(await new Author().connect(db).betweenReadCount([10, 20]).getCount() === 2, 'between');
  check(await new Author().connect(db).gtStartDt(new Date(start.getTime() + 90 * 60_000)).getCount() === 2, 'time compare');
  const one = await new Author().connect(db).getByName('gamma');
  check(one !== null && one.getReadCount() === 20, 'getBy');
  check(await code(new Author().connect(db).getByName('missing')) === 'NO_ROWS', 'get without a row returns NO_ROWS');
  const q = new Author().connect(db).serviceSeq(svc);
  const first = await q.getCountByIsClose(true);
  const second = await q.getCount();
  check(first === 2 && second === 4, `terminal changed the model: ${first} ${second}`);
  check(await new Author().connect(db).geReadCount(20).getCount() === 2, 'ge');
  check(await code(new Author().connect(db).name('a').isClose(true).gets()) === 'CONFIG', 'missing connector');
  check(await code(new Author().connect(db).name('a').and().gets()) === 'CONFIG', 'dangling connector');
  check(await code(new Author().connect(db).seq([]).gets()) === 'EMPTY_IN', 'empty list');
  const st = await new Author().connect(db).name('alpha').getQuery();
  check(st.sql.includes('name') && st.binds.length === 1, `getQuery: ${JSON.stringify(st)}`);
  check(await code(new Author().name('alpha').gets()) === 'CONFIG', 'no connection');
}

async function joinsAndRelations(db, dsn) {
  const f = await seed(db);
  const author = new User().on(u => u.neName('nobody')).name('kim');
  const rows = await new Author().connect(db)
    .leftJoinUserSeqWithSeq(author)
    .serviceSeq(f.service.getSeq())
    .and(q => q.name('delta').or(author))
    .orderBySeqAsc().gets();
  check(names(rows) === 'alpha,gamma,delta', `placed join conditions: ${names(rows)}`);
  check(rows.first().getUserModel()?.getName() === 'kim', 'join result');
  const member = new ServiceMember();
  const cmp = await new Author().connect(db).joinServiceMemberSeqWithSeq(member).readCountGtSeq(member).getCount();
  check(cmp === 3, `column comparison with a joined model: ${cmp}`);

  const loaded = await new Author().connect(db)
    .relation(new User().matchUserSeqWithSeq().aliasWriter())
    .relations(new ServiceMember().matchServiceSeqWithServiceSeq().aliasMembers())
    .relation(new ServiceRegion().matchServiceRegionSeqWithSeq())
    .orderBySeqAsc().gets();
  const b = loaded.first();
  check(b.getWriter()?.getName() === 'kim', 'relation alias');
  check(b.getMembers().length === 1 && b.getServiceRegionModel().getName() === 'module', 'relations');
  const limited = await new User().connect(db)
    .relations(new Author().matchSeqWithUserSeq().orderBySeqDesc().groupLimit(1))
    .orderBySeqAsc().gets();
  const got = limited.first().getAuthorModels();
  check(got.length === 1 && got.first().getName() === 'gamma', `groupLimit: ${names(got)}`);
  const other = await connect(dsn);
  try {
    const external = await new Author().connect(db)
      .relation(new User().connect(other).matchUserSeqWithSeq().aliasOwner())
      .getByName('beta');
    check(external.getOwner()?.getName() === 'lee', 'relation on another connection');
  } finally { await other.close(); }
  check(await code(new Author().connect(db).joinUserSeqWithSeq(new User().connect(db)).gets()) === 'CONFIG', 'join child with connection');
  check(await code(new Author().connect(db).name('a').or(new User()).gets()) === 'CONFIG', 'unjoined model placement');
  const array = b.toArray();
  check(array.writer !== null && array.writer !== undefined && array.name === 'alpha', `toArray: ${JSON.stringify(array)}`);
}

async function columnsAndSubqueries(db) {
  const f = await seed(db);
  const users = await new User().connect(db)
    .addColumnReadTotal(u => new Author().sumReadCount().userSeqEqSeq(u))
    .seq(new Author().addColumnUserSeq().isClose(false))
    .orderBySeqAsc().gets();
  check(users.length === 1, `subquery IN: ${users.length}`);
  const u = users.first();
  check(Number(u.getReadTotal()) === 20, `added column: ${u.getReadTotal()}`);
  const sum = await new Author().connect(db).serviceSeq(f.service.getSeq()).sumReadCount().getSum();
  const avg = await new Author().connect(db).serviceSeq(f.service.getSeq()).avgReadCount().getAvg();
  check(sum === 60 && avg === 15, `aggregates: ${sum} ${avg}`);
  check((await new Author().connect(db).groupByIsClose().getsCount()).length === 2, 'getsCount');
  const page = await new Author().connect(db).orderBySeqAsc().getsPage(2, 3);
  check(page.totalCount === 4 && page.totalPages === 2 && page.items.length === 1 && page.items.first().getName() === 'delta', 'page');
  const keyed = await new Author().connect(db).keyNameName().gets();
  check(keyed.get('beta') !== undefined, 'keyName');
  const fetched = await new Author().connect(db).fetchKey(b => `k${b.getSeq()}`).fetchValue(b => b.getName()).orderBySeqAsc().gets();
  check(fetched.fetched(`k${f.authors[0].getSeq()}`) === 'alpha', 'fetchKey and fetchValue');
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
  const b = await new Author().connect(db).getBySeq(f.authors[0].getSeq());
  await b.setName('renamed').plusReadCount(5).update(true);
  const again = await new Author().connect(db).getBySeq(b.getSeq());
  check(again.getName() === 'renamed' && again.getReadCount() === 5, `update: ${again.getName()} ${again.getReadCount()}`);
  check(await code(b.setName('stale').update(true)) === 'CONFIG', 'optimistic update without a fresh version');
  await again.setName('again').update();
  await b.setName('x').update();
  const item = await new Account().connect(db).setName('acc').newLabel('shown').create();
  check(item.getLabel() === 'shown' && item.toArray().label === 'shown', `new value: ${JSON.stringify(item.toArray())}`);
  const saved = await new Account().connect(db).setSeq(item.getSeq()).setName('saved').save();
  check(saved.getName() === 'saved' && (await new Account().connect(db).getBySeq(item.getSeq())).getName() === 'saved', 'save as update');
  await (await new Author().connect(db).getBySeq(f.authors[3].getSeq())).delete();
  check(await new Author().connect(db).getCount() === 3, 'delete');
  await (await new Author().connect(db).isClose(true).gets()).delete();
  check(await new Author().connect(db).getCount() === 2, 'collection delete');
  await new CompositeAccount().connect(db).setTenantId(9).setAccountId(9).setName('first').create();
  await new CompositeAccount().connect(db).setTenantId(9).setAccountId(9).setName('first')
    .duplication(new CompositeAccount().setName('second')).create();
  check((await new CompositeAccount().connect(db).getByTenantIdAndAccountId(9, 9)).getName() === 'second', 'duplication');
  await jsonValues(db, f);
}

/**
 * Writes jsontext columns from an ordered-json value and from the common value
 * model and reads back ordered-json values with the same text.
 */
async function jsonValues(db, f) {
  const text = '{"b":1,"a":[],"c":{},"n":1.50}';
  const created = await new Author().connect(db)
    .setName('json').setUserSeq(f.users[0].getSeq()).setServiceSeq(f.service.getSeq())
    .setServiceRegionSeq(f.module.getSeq()).setServiceMemberSeq(f.member.getSeq())
    .setStartDt('2026-01-02 00:00:00').setEndDt('2026-01-03 00:00:00')
    .setJsonSetting(StyledValue.value(parseJson(text))).setJsonsTags(StyledValue.value({ b: 1, a: [], c: {} })).create();
  const row = await new Author().connect(db).addAllColumns().getBySeq(created.getSeq());
  const setting = row.getJsonSetting();
  check(setting instanceof StyledValue && setting.kind === 'value' && setting.payload() instanceof JsonValue && stringifyJson(setting.payload()) === text, 'jsontext read');
  const tags = row.getJsonsTags();
  check(tags instanceof StyledValue && tags.kind === 'value' && tags.payload() instanceof JsonValue && stringifyJson(tags.payload()) === '{"b":1,"a":[],"c":{}}', 'common value model read');
  check(row.toArray().json_setting.kind === 'value' && row.toArray().json_setting.value === setting.payload(), 'toArray keeps the tagged ordered-json value');
  // JSON output writes an ordered-json value as its stored text, in row order.
  const rowText = JSON.stringify(row);
  check(rowText.includes(`"json_setting":{"kind":"value","value":${text}}`), `JSON.stringify(model) ${rowText}`);
  check(JSON.stringify(row.toJSON()) === rowText, 'toJSON is the JSON.stringify form');
  check(Object.keys(JSON.parse(rowText)).join(',') === Object.keys(row.toArray()).join(','), 'JSON output keeps the row order');
  check(row.toJSONText() === rowText, `toJSONText ${row.toJSONText()}`);
  const indexKeyed = await new Author().connect(db).addAllColumns().getBySeq(created.getSeq());
  indexKeyed.setJsonSetting(StyledValue.value(parseJson('{"b":1,"1":2}')));
  check(await code(Promise.resolve().then(() => JSON.stringify(indexKeyed))) === 'CODEC_ENCODE', 'JSON.stringify rejects a key that JavaScript reorders');
  check(indexKeyed.toJSONText().includes('"json_setting":{"kind":"value","value":{"b":1,"1":2}}'), `toJSONText keeps a reordered key ${indexKeyed.toJSONText()}`);
  const listed = await new Author().connect(db).addAllColumns().seq([created.getSeq()]).gets();
  const listText = JSON.stringify(listed);
  check(listText.startsWith('[{') && listText.includes(`"json_setting":{"kind":"value","value":${text}}`), `JSON.stringify(collection) ${listText}`);
  check(listed.toJSONText() === listText, 'collection toJSONText');
  const owner = await new User().connect(db).relations(new Author().addAllColumns().matchSeqWithUserSeq().seq([created.getSeq()])).seq(f.users[0].getSeq()).get();
  const ownerText = JSON.stringify(owner);
  check(ownerText.includes(`"json_setting":{"kind":"value","value":${text}}`), `JSON.stringify(model with relation) ${ownerText}`);
  const nonFinite = await code(Promise.resolve().then(() => new Author().connect(db).setSeq(created.getSeq()).setJsonSetting(StyledValue.value({ bad: Number.NaN })).update()));
  check(String(nonFinite).includes('CODEC_ENCODE'), `non-finite number: ${nonFinite}`);
  await row.setJsonSetting(StyledValue.value(parseJson('[{"z":0},{}]'))).update();
  const again = await new Author().connect(db).addAllColumns().getBySeq(created.getSeq());
  check(stringifyJson(again.getJsonSetting().payload()) === '[{"z":0},{}]', 'updated read');
  await again.delete();
}

async function authorStyledCells(dialect, dsn, seq) {
  if (!Number.isSafeInteger(seq)) throw new Error('author key is not a safe integer');
  const sql = `SELECT json_setting, jsons_tags, serialize_data FROM author WHERE seq = ${seq}`;
  if (dialect === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const path = new URL(dsn).pathname;
    const conn = new DatabaseSync(path);
    try { return conn.prepare(sql).get(); } finally { conn.close(); }
  }
  if (dialect === 'mysql') {
    const conn = await mysqlConnection(dsn);
    try { const [rows] = await conn.query(sql); return rows[0]; } finally { await conn.end(); }
  }
  const conn = postgresClient(dsn);
  await conn.connect();
  try { const { rows } = await conn.query(sql); return rows[0]; } finally { await conn.end(); }
}

async function styledStates(db, dsn) {
  const dialect = new URL(dsn).protocol.slice(0, -1);
  const fixture = JSON.parse(await readFile(join(root, 'contracts/fixtures/styled_column_states.json'), 'utf8'));
  const cases = Object.fromEntries(fixture.cases.map(entry => [entry.id, entry]));
  const f = await seed(db);
  const seq = f.authors[0].getSeq();
  const row = await new Author().connect(db).addAllColumns().getBySeq(seq);
  check(row.getJsonSetting().kind === 'sql-null', 'SQL NULL getter');
  check(JSON.stringify(row.toArray().json_setting) === JSON.stringify(cases.sql_null.output), 'SQL NULL array output');
  check(JSON.stringify(row.toJSON().json_setting) === JSON.stringify(cases.sql_null.output), 'SQL NULL JSON output');
  const partial = await new Author().connect(db).removeAllColumns().addColumnName().getBySeq(seq);
  check(await code(Promise.resolve().then(() => partial.getJsonSetting())) === cases.unselected.getter_error, 'unselected getter');

  await row.setJsonSetting(StyledValue.value(parseJson('null')))
    .setJsonsTags(StyledValue.value(parseJson('null')))
    .setSerializeData(StyledValue.value(null)).update();
  const loaded = await new Author().connect(db).addAllColumns().getBySeq(seq);
  check(loaded.toArray().json_setting.kind === cases.json_null.output.kind
    && stringifyJson(loaded.toArray().json_setting.value) === 'null', 'JSON null array');
  check(loaded.toArray().jsons_tags.kind === cases.jsons_value_null.output.kind
    && stringifyJson(loaded.toArray().jsons_tags.value) === 'null', 'JSONS null array');
  check(JSON.stringify(loaded.toArray().serialize_data) === JSON.stringify(cases.serialize_value_null.output), 'serialize null array');
  check(JSON.stringify(loaded.toJSON().json_setting) === JSON.stringify(cases.json_null.output), 'JSON null JSON output');
  let cells = await authorStyledCells(dialect, dsn, seq);
  check(cells.json_setting === 'null' && cells.jsons_tags === 'null' && cells.serialize_data === 'N;', 'encoded null storage');

  await loaded.setJsonSetting(StyledValue.value(parseJson('{"kind":"sql-null"}'))).update();
  const object = await new Author().connect(db).addAllColumns().getBySeq(seq);
  check(JSON.stringify(object.toJSON().json_setting) === JSON.stringify(cases.json_object_with_kind.output), 'JSON value does not collide with tag');
  await object.setJsonSetting(StyledValue.sqlNull()).setJsonsTags(StyledValue.sqlNull()).setSerializeData(StyledValue.sqlNull()).update();
  const nulls = await new Author().connect(db).addAllColumns().getBySeq(seq);
  check(JSON.stringify(nulls.toArray().json_setting) === JSON.stringify(cases.sql_null.output), 'SQL NULL restored');
  cells = await authorStyledCells(dialect, dsn, seq);
  check(cells.json_setting === null && cells.jsons_tags === null && cells.serialize_data === null, 'SQL NULL storage');
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
    await db.utils().setLocal('ormtest.actor', 'tester');
    check(await db.utils().local('ormtest.actor') === 'tester', 'local');
    check(await code(db.utils().local('ormtest.missing')) === 'NO_ROWS', 'missing local');
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

async function aesRotation(db, dsn) {
  const f = await seed(db);
  const b = await new Author().connect(db).getBySeq(f.authors[0].getSeq());
  await b.setAesHexEmail('person@example.com').update();
  const found = await new Author().connect(db).aesHexEmail('person@example.com').getBySeq(b.getSeq());
  check(found?.getAesHexEmail() === 'person@example.com', 'aes round trip and blind index');
  const keyring = new AesKeyring(new Map([[1, 'test-aes-key'], [2, 'next-aes-key']]), 2);
  let status = await db.utils().aes().status(new Author(), keyring);
  check(status.total === 4 && status.pending === 4, `status: ${JSON.stringify(status)}`);
  const rotated = await db.utils().aes().rotate(new Author(), keyring);
  check(rotated === 4, `rotated ${rotated}`);
  status = await db.utils().aes().status(new Author(), keyring);
  check(status.pending === 0, `after rotation: ${JSON.stringify(status)}`);
  // A write with only aesKeys and aesVersion encrypts with aesKeys[aesVersion].
  const versioned = await connectBench(dsn, { blindIndexKey: 'test-blind-key', aesVersion: 2, aesKeys: new Map([[1, 'test-aes-key'], [2, 'next-aes-key']]) });
  const current = await connectBench(dsn, { blindIndexKey: 'test-blind-key', aesVersion: 2, aesKeys: new Map([[2, 'next-aes-key']]) });
  try {
    check(await code((async () => { await (await new Author().connect(versioned).getBySeq(f.authors[1].getSeq())).setAesHexEmail('second@example.com').update(); })()) === null, 'write with aesKeys and aesVersion');
    check((await new Author().connect(current).getBySeq(f.authors[1].getSeq())).getAesHexEmail() === 'second@example.com', 'write with the key of aesVersion');
    check(await code(connectBench(dsn, { aesKey: 'other-key', aesKeys: new Map([[1, 'test-aes-key']]) })) === 'CONFIG', 'aesKey differs from aesKeys[aesVersion]');
  } finally {
    await versioned.close();
    await current.close();
  }
}

function connect(dsn) {
  return connectBench(dsn, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key' });
}

/**
 * 모든 connection은 server의 time zone과 상관없이 datetime을 UTC로 읽고 쓴다
 * (docs/dialects.md "Date and time"). 시험 server의 MySQL은 SYSTEM(KST),
 * PostgreSQL은 Asia/Seoul이다. offset이 있는 instant는 UTC wall clock으로 저장되고,
 * clock default도 UTC다.
 */
async function connectionsUseUtc(db) {
  const f = await seed(db);
  const midnight = new Date('2026-01-02T00:00:00+09:00');
  const before = Date.now();
  const created = await new Author().connect(db)
    .setName('zone').setUserSeq(f.users[0].getSeq()).setServiceSeq(f.service.getSeq())
    .setServiceRegionSeq(f.module.getSeq()).setServiceMemberSeq(f.member.getSeq())
    .setStartDt(midnight).setEndDt('2026-01-03 00:00:00').create();
  const row = await new Author().connect(db).getBySeq(created.getSeq());
  check(row?.getStartDt() === '2026-01-01 15:00:00.000000', `start_dt ${row?.getStartDt()}`);
  const wall = text => Date.parse(`${text.replace(' ', 'T').slice(0, 23)}Z`);
  check(row !== null && Math.abs(wall(row.getCreatedTs()) - before) < 60_000, `created_ts ${row?.getCreatedTs()} at ${new Date(before).toISOString()}`);
  check(await new Author().connect(db).startDt(midnight).getCount() === 1, 'equality filter with an instant');
  check(await new Author().connect(db).startDt('2026-01-01 15:00:00').getCount() === 1, 'equality filter by text');
  check(await new Author().connect(db).startDt('2026-01-01T15:00:00.0').getCount() === 1, 'equality filter by text with fraction');
  check(await new Author().connect(db).startDt(['2026-01-01 15:00:00', '2026-01-03 00:00:00']).getCount() === 1, 'in filter by text');
  check(await new Author().connect(db).betweenStartDt(['2026-01-01 15:00:00', '2026-01-01 15:00:00.5']).getCount() === 1, 'between filter by text');
  if (db.driver === 'sqlite') {
    check(await code(new Author().connect(db).startDt('2026-01-02').getCount()) === 'CODEC_ENCODE', 'date-only datetime text');
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
  await db.transaction(async () => { inside = await code(db.utils().schema().install(SCHEMA)); });
  check(inside === 'CONFIG', `install inside a transaction: ${inside}`);
}

/** Registers the model of one dbspec document and returns a model class per entity. */
function documentModels(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const models = {};
  for (const entity of model.entities.values()) {
    const cls = class extends Model {};
    cls.entity = { model, entity, create: core => new cls(core) };
    models[entity.name] = cls;
  }
  return models;
}

/**
 * Writes a JSON value to an encrypted `ordered_json aes` column, reads it
 * back, rotates the row to the next key version, and updates it with the
 * first key version.
 */
async function aesJsonColumn(dialect, dsn, sqlitePath) {
  const secret = await readFile(join(root, 'contracts/fixtures/secret_config.dbs'), 'utf8');
  const { secret_config: SecretConfig } = documentModels(secret);
  const text = '{"b":1,"a":[],"c":{},"n":1.50,"token":"s3cret-token"}';
  const updatedText = '{"token":"next-token","list":[1,"two",null]}';
  const open = (keys, version) => Db.connectSchema(dsn, schemaOf(secret), { aesKey: keys.get(version), aesVersion: version, aesKeys: keys });
  const read = async db => {
    const rows = [...(await new SecretConfig().connect(db).addAllColumns().gets()).values()];
    check(rows.length === 1, `rows ${rows.length}`);
    const config = rows[0][CORE].column('config');
    check(config instanceof StyledValue && config.kind === 'value' && config.payload() instanceof JsonValue, 'the json aes column reads a styled ordered-json value');
    return stringifyJson(config.payload());
  };
  const one = new Map([[1, 'config-key-one']]);
  const both = new Map([[1, 'config-key-one'], [2, 'config-key-two']]);
  const first = await open(one, 1);
  let seq;
  try {
    await first.utils().schema().install(schemaOf(secret));
    const created = new SecretConfig().connect(first);
    created[CORE].setValue('config', StyledValue.value(parseJson(text)));
    seq = (await created.create())[CORE].column('seq');
    check(await read(first) === text, `read back ${await read(first)}`);
    const [cell, version] = await storedCell(dialect, dsn, sqlitePath);
    check(Buffer.from(cell).subarray(0, 9).toString('latin1') === 'ORM-AES2\0' && !Buffer.from(cell).includes('s3cret-token') && Number(version) === 1, `stored version ${version}`);
  } finally { await first.close(); }
  const second = await open(both, 2);
  try {
    check(await read(second) === text, 'mixed-version read');
    const keyring = new AesKeyring(both, 2);
    check(await second.utils().aes().rotate(new SecretConfig(), keyring) === 1, 'rotate');
    check(Number((await storedCell(dialect, dsn, sqlitePath))[1]) === 2, 'rotated version');
  } finally { await second.close(); }
  const rotated = await open(new Map([[2, 'config-key-two']]), 2);
  try { check(await read(rotated) === text, 'rotated read'); } finally { await rotated.close(); }
  const again = await open(both, 1);
  try {
    const changed = new SecretConfig().connect(again);
    changed[CORE].setValue('seq', seq);
    changed[CORE].setValue('config', StyledValue.value(JSON.parse(updatedText)));
    await changed.update();
    check(Number((await storedCell(dialect, dsn, sqlitePath))[1]) === 1, 'updated version');
    check(await read(again) === updatedText, `updated read ${await read(again)}`);
  } finally { await again.close(); }
}

/** The stored config cell and key version of the single secret_config row. */
async function storedCell(dialect, dsn, sqlitePath) {
  const sql = 'SELECT config, aes_key_version FROM secret_config';
  if (dialect === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(sqlitePath);
    try { const row = db.prepare(sql).get(); return [row.config, row.aes_key_version]; } finally { db.close(); }
  }
  if (dialect === 'mysql') {
    const conn = await mysqlConnection(dsn);
    try { const [rows] = await conn.query(sql); return [rows[0].config, rows[0].aes_key_version]; } finally { await conn.end(); }
  }
  const client = postgresClient(dsn);
  await client.connect();
  try { const { rows } = await client.query(sql); return [rows[0].config, rows[0].aes_key_version]; } finally { await client.end(); }
}

const zones = ['', 'UTC', '+00:00'];

// poolSize와 failedLocalReset, failedLockRelease는 schema를 설치하지 않고 table도 만들지 않으므로
// DSN이 가리키는 database에 연결만 한다. 나머지 case는 저마다 case database를 받는다.
const targets = [['sqlite', `sqlite://${join(work, 'model.sqlite')}?_pragma=busy_timeout(5000)`]];
if (!process.env.ORM_TEST_MYSQL_DSN) throw new Error('ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers');
if (!process.env.ORM_TEST_POSTGRES_DSN) throw new Error('ORM_TEST_POSTGRES_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers');
targets.push(['mysql', process.env.ORM_TEST_MYSQL_DSN]);
targets.push(['postgres', process.env.ORM_TEST_POSTGRES_DSN]);
const cases = { conditions, joinsAndRelations, columnsAndSubqueries, writes, styledStates, transactions, aesRotation, bindLimitSplitting };
if (selectedCase !== undefined) targets.splice(0, targets.length, ...targets.filter(([dialect]) => dialect === args[3]));
const dialects = targets.map(([dialect]) => dialect);

/**
 * 열린 case에서 dialect의 새 case database로 body(dsn, database)를 실행하고 끝나면 지운다. SQLite DSN은
 * busy_timeout을 가진다. body나 database 지우기의 실패는 열린 case의 FAIL이 된다.
 */
async function inCaseDatabase(dialect, body) {
  try {
    await withCaseDatabase(dialect, text => caseLog.step(text), database =>
      body(dialect === 'sqlite' ? `${database.dsn}?_pragma=busy_timeout(5000)` : database.dsn, database));
  } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
}

try {
  if (selectedCase === undefined) {
  for (const dialect of dialects) {
    begin(`${dialect}/schemaEmpty`);
    await inCaseDatabase(dialect, dsn => schemaEmpty(dialect, dsn));
    end();
  }
  }
  for (const dialect of dialects) {
    for (const [name, fn] of Object.entries(cases).filter(([name]) => selectedCase === undefined || name === selectedCase)) {
      begin(`${dialect}/${name}`);
      await inCaseDatabase(dialect, async dsn => {
        await install(dsn);
        const db = await connect(dsn);
        try { await fn(db, dsn); } finally { await db.close(); }
      });
      end();
    }
  }
  if (selectedCase === undefined) {
  for (const [dialect, dsn] of targets) {
    begin(`${dialect}/poolSize`);
    const sized = await connectBench(dsn, { poolSize: 3 });
    try {
      // The SQLite driver holds one connection, so the size applies to the pooled drivers.
      const want = dialect === 'sqlite' ? 1 : 3;
      check(sized.utils().stats().maxOpenConnections === want, `configured pool size ${sized.utils().stats().maxOpenConnections}`);
      check(await code(connectBench(dsn, { poolSize: -1 })) === 'CONFIG', 'negative pool size');
      for (const options of [{}, { poolSize: 0 }]) {
        const unset = await connectBench(dsn, options);
        try {
          const got = unset.utils().stats().maxOpenConnections;
          check(got === (dialect === 'sqlite' ? 1 : 10), `pool size ${JSON.stringify(options)}: ${got}`);
        } finally { await unset.close(); }
      }
      if (dialect !== 'sqlite') {
        // Each transaction holds a connection while it runs, so six
        // transactions on a pool of two run at most two at a time.
        const bounded = await connectBench(dsn, { poolSize: 2 });
        try {
          let active = 0;
          let peak = 0;
          let opened = 0;
          await Promise.all(Array.from({ length: 6 }, () => bounded.transaction(async () => {
            active++;
            peak = Math.max(peak, active);
            opened = Math.max(opened, bounded.utils().stats().openConnections);
            await new Promise(resolve => setTimeout(resolve, 50));
            active--;
          })));
          check(peak === 2 && opened <= 2, `pool of 2: ${peak} concurrent transactions, ${opened} open connections`);
        } finally { await bounded.close(); }
        // Three transactions hold three connections at once; after they end
        // the pool keeps one idle connection and closes the others.
        const idle = await connectBench(dsn, { poolSize: 3, poolIdleSize: 1 });
        try {
          let release;
          let arrived;
          const held = new Promise(resolve => { release = resolve; });
          const allStarted = new Promise(resolve => { arrived = resolve; });
          let started = 0;
          const all = Promise.all(Array.from({ length: 3 }, () => idle.transaction(async () => { if (++started === 3) arrived(); await held; })));
          await allStarted;
          check(idle.utils().stats().openConnections === 3, `three transactions hold ${idle.utils().stats().openConnections} connections`);
          release();
          await all;
          const stats = idle.utils().stats();
          check(stats.idle === 1 && stats.openConnections === 1, `pool idle size 1 keeps ${stats.idle} idle of ${stats.openConnections} open connections`);
        } finally { await idle.close(); }
        // A connection is closed when its lifetime passes, idle or at its release.
        const aged = await connectBench(dsn, { poolLifetimeMs: 100 });
        try {
          check(aged.utils().stats().openConnections === 1, 'the connection opened by connect');
          await new Promise(resolve => setTimeout(resolve, 400));
          check(aged.utils().stats().openConnections === 0, `pool lifetime 100 ms keeps ${aged.utils().stats().openConnections} connections open after 400 ms`);
        } finally { await aged.close(); }
      }
      for (const options of [{ poolIdleSize: -1 }, { poolSize: 3, poolIdleSize: 4 }, { poolLifetimeMs: -1 }]) {
        check(await code(connectBench(dsn, options)) === 'CONFIG', `pool options ${JSON.stringify(options)}`);
      }
    } catch (error) { failures++; console.error(`FAIL ${current}:`, error); } finally { await sized.close(); }
    end();
  }
  for (const dialect of dialects) {
    begin(`${dialect}/statementTimeout`);
    await inCaseDatabase(dialect, async dsn => {
      await install(dsn);
      check(await code(connectBench(dsn, { statementTimeoutMs: -1 })) === 'CONFIG', 'negative statement timeout');
      // MySQL bounds SELECT statements, PostgreSQL bounds every statement, and
      // SQLite has no session timeout. The bounded statement is a locking read
      // of a row that another connection holds, so it waits past the bound.
      if (dialect !== 'sqlite') {
        const bounded = await connectBench(dsn, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key', statementTimeoutMs: 200 });
        try {
          await seed(bounded);
          const release = await holdRows(dialect, dsn, 'author');
          try {
            check(await code(lockedRead(bounded, Author)) === 'CANCELED', 'a statement past the timeout');
          } finally { await release(); }
        } finally { await bounded.close(); }
      }
    });
    end();
  }
  {
    // A pooler in transaction mode hands one server session to every client
    // in turn. Through ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one
    // server connection, so the statement timeout of one connection must
    // bound only the statements of that connection.
    // PgBouncer의 orm_test_single은 정해진 database 하나에만 닿으므로 새 case database를 쓸 수
    // 없다. case는 그 database에 자기 이름(orm_case_<pid>_<counter>)의 table 하나를 만들고, 끝날 때
    // 실패한 뒤에도 그 table만 지운다.
    begin('postgres/statementTimeoutThroughAPooler');
    try {
      const single = process.env.ORM_TEST_PGBOUNCER_SINGLE_DSN;
      if (!single) throw new Error('ORM_TEST_PGBOUNCER_SINGLE_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers');
      const table = caseName();
      const probeText = `dbspec 1 pooler_probe\n\ntable ${table} {\n  seq i64 identity\n  label varchar(32)\n  primary key (seq)\n}\n`;
      const { [table]: Probe } = documentModels(probeText);
      const probe = schemaOf(probeText);
      const setup = await Db.connect(single);
      try {
        await setup.utils().schema().install(probe);
        caseLog.step(`table ${table} created`);
        for (let i = 0; i < 4; i++) {
          const row = new Probe().connect(setup);
          row[CORE].setValue('label', `row-${i}`);
          await row.create();
        }
        const bounded = await Db.connect(single, { statementTimeoutMs: 200 });
        const plain = await Db.connect(single, {});
        // A direct connection holds the rows, so a locking read through the pooler waits for the lock.
        const base = process.env.ORM_TEST_POSTGRES_DSN;
        let release = await holdRows('postgres', base, table);
        try {
          await bounded.utils().schema().install(probe);
          await plain.utils().schema().install(probe);
          check(await code(lockedRead(bounded, Probe)) === 'CANCELED', 'the bounded connection through the pooler');
          // The holder keeps the rows for a declared 400 ms, past the 200 ms bound of the other
          // connection, so the plain read waits that long and then succeeds.
          const held = setTimeout(() => { release(); }, 400);
          const started = Date.now();
          try {
            await lockedRead(plain, Probe);
            check(Date.now() - started >= 200, 'a connection without a timeout after the bounded one waits past the bound');
          } catch (error) { check(false, `a connection without a timeout after the bounded one: ${error.message}`); } finally { clearTimeout(held); await release(); }
          release = await holdRows('postgres', base, table);
          check(await code(lockedRead(bounded, Probe)) === 'CANCELED', 'the bounded connection after the plain one');
        } finally { await release(); await bounded.close(); await plain.close(); }
      } finally {
        await setup.close();
        const client = postgresClient(single);
        await client.connect();
        try { await client.query(`DROP TABLE IF EXISTS "${table}"`); } catch (error) {
          throw new Error(`drop table ${table}: ${error.message}`);
        } finally { await client.end(); }
        caseLog.step(`table ${table} dropped`);
      }
    } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
    end();
  }
  for (const dialect of dialects) {
    begin(`${dialect}/cancellation`);
    await inCaseDatabase(dialect, async dsn => {
      await install(dsn);
      const db = await connect(dsn);
      try {
        const fixture = await seed(db);
        const before = new AbortController();
        before.abort();
        check(await code(new Author().connect(db.withSignal(before.signal)).getCount()) === 'CANCELED', 'a signal aborted before the statement');
        // The running statement is an update of a row that another connection holds, so it waits
        // for the lock until the signal aborts. SQLite waits for a lock in its busy handler, which
        // an abort does not interrupt, so SQLite checks only the signal aborted before.
        if (dialect !== 'sqlite') {
          const release = await holdRows(dialect, dsn, 'author');
          try {
            const row = fixture.authors[0];
            const running = new AbortController();
            const timer = setTimeout(() => running.abort(), 300);
            // The statement returns CANCELED after the abort while the other connection still holds the row:
            // it ended because of the signal, not because the lock was released or its wait timed out.
            check(await code(row.connect(db.withSignal(running.signal)).setName('changed').update()) === 'CANCELED', 'a statement cancelled while it runs');
            check(running.signal.aborted, 'the cancelled statement returned only after the abort');
            clearTimeout(timer);
          } finally { await release(); }
        }
        check(typeof await new Author().connect(db).getCount() === 'number', 'the connection is usable after a cancellation');
      } finally { await db.close(); }
    });
    end();
  }
  for (const dialect of dialects) {
    begin(`${dialect}/aesJsonColumn`);
    // SQLite case는 busy_timeout 없는 DSN으로 연결하고 저장된 cell을 file에서 직접 읽는다.
    await inCaseDatabase(dialect, (dsn, database) => aesJsonColumn(dialect, database.dsn, database.path));
    end();
  }
  for (const dialect of dialects.filter(dialect => dialect === 'mysql')) {
    begin(`${dialect}/installInsideTransaction`);
    await inCaseDatabase(dialect, async dsn => {
      await install(dsn);
      const db = await connect(dsn);
      try { await mysqlInstallInsideTransaction(db); } finally { await db.close(); }
    });
    end();
  }
  for (const dialect of dialects) {
    for (const zone of zones) {
      begin(`${dialect}/connectionsUseUtc/${zone}`);
      await inCaseDatabase(dialect, async base => {
        const dsn = zone === '' ? base : `${base}${base.includes('?') ? '&' : '?'}timezone=${encodeURIComponent(zone)}`;
        await install(dsn);
        const db = await connect(dsn);
        try { await connectionsUseUtc(db); } finally { await db.close(); }
      });
      end();
    }
  }
  if (dialects.includes('sqlite')) {
    // A connection to a SQLite database file that the process may only read:
    // SQLite opens it read-only, reads succeed, and a write returns READ_ONLY.
    begin('sqlite/readOnly');
    await inCaseDatabase('sqlite', async (_, database) => {
      await install(database.dsn);
      const writable = await connect(database.dsn);
      try { await new User().connect(writable).setName('read-only').create(); } finally { await writable.close(); }
      await chmod(database.path, 0o444);
      const readOnly = await connect(database.dsn);
      try {
        check(await new User().connect(readOnly).name('read-only').getCount() === 1, 'the read-only database reads the row');
        check(await code(new User().connect(readOnly).setName('rejected').create()) === 'READ_ONLY', 'a write to the read-only database');
      } finally { await readOnly.close(); }
    });
    end();
  }
  for (const dialect of dialects) {
    if (dialect === 'sqlite') continue;
    begin(`${dialect}/primaryAndReplica`);
    // replica DSN은 case database와 같은 이름을 가리킨다. replica는 primary의 CREATE DATABASE를
    // 복제하고, primaryAndReplica는 replica에 연결하기 전에 replica가 따라오기를 기다린다.
    await inCaseDatabase(dialect, async primary => {
      const replica = process.env[`ORM_TEST_${dialect.toUpperCase()}_REPLICA_DSN`];
      if (!replica) throw new Error(`ORM_TEST_${dialect.toUpperCase()}_REPLICA_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
      await primaryAndReplica(dialect, primary, relatedDsn(replica, new URL(primary).pathname.slice(1)));
    });
    end();
  }
  // transaction 끝의 MySQL local 값 reset이 실패하면 commit과 rollback이 그 오류를 보고한다.
  // MySQL user variable은 COMMIT과 ROLLBACK 뒤에도 남는다(mysql.context.user_variable_session_scope).
  // 실제 server는 reset을 거부하지 않으므로 transaction connection의 control이 reset만 실패시킨다.
  begin('mysql/failedLocalReset');
  try {
    const db = await connectBench(process.env.ORM_TEST_MYSQL_DSN);
    try {
      const failReset = () => {
        const session = db.utils().active('setLocal').session;
        const control = session.control.bind(session);
        session.control = (sql, params, done) => sql.startsWith('SET @`orm.') && sql.endsWith('= NULL') ? Promise.reject(new Error('reset rejected by the test driver')) : control(sql, params, done);
      };
      const message = async promise => { try { await promise; return 'no error'; } catch (error) { return String(error?.message); } };
      const committed = await message(db.transaction(async () => { failReset(); await db.utils().setLocal('ormtest.actor', 'tester'); }, { retry: 0 }));
      check(committed.includes('reset rejected by the test driver'), `commit reports the failed reset: ${committed}`);
      let rolledBack = null;
      try {
        await db.transaction(async () => { failReset(); await db.utils().setLocal('ormtest.actor', 'tester'); throw new Error('callback failed'); }, { retry: 0 });
      } catch (error) { rolledBack = error; }
      check(rolledBack instanceof OrmError && rolledBack.code === 'ROLLBACK' && rolledBack.message.startsWith('ROLLBACK: transaction failed (callback failed) and rollback failed (') && rolledBack.message.includes('callback failed') && rolledBack.message.includes('reset rejected by the test driver'), `rollback reports the callback and the failed reset: ${rolledBack?.message}`);
    } finally {
      await db.close();
    }
  } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
  end();
  const failureMessage = async promise => { try { await promise; return 'no error'; } catch (error) { return String(error?.message); } };
  // message가 원인과 transaction 끝의 오류를 함께 담은 ROLLBACK인지 확인한다.
  const checkBoth = (what, message, cause, end) => check(message.startsWith('ROLLBACK: transaction failed (') && message.includes(cause) && message.includes(`and rollback failed (`) && message.includes(end), `${what} reports the cause and the failed transaction end: ${message}`);
  // transaction 끝의 MySQL RELEASE_LOCK이 실패하거나 lock을 풀지 못하면 commit과 rollback이 그 오류를
  // 보고하고, 그 connection은 pool에 돌아가지 않는다(mysql/failedEndDiscards). 실제 server는 RELEASE_LOCK을 거부하지 않으므로
  // transaction connection의 control이 RELEASE_LOCK만 실패시킨다.
  begin('mysql/failedLockRelease');
  try {
    const db = await connectBench(process.env.ORM_TEST_MYSQL_DSN);
    try {
      const key = name => `orm_test.${name}.${process.pid}`;
      const failRelease = () => {
        const session = db.utils().active('lock').session;
        const control = session.control.bind(session);
        session.control = (sql, params, done) => sql.startsWith('SELECT RELEASE_LOCK') ? Promise.reject(new Error('statement rejected by the test driver')) : control(sql, params, done);
      };
      const committed = await failureMessage(db.transaction(async () => { failRelease(); await db.utils().lock(key('commit')); }, { retry: 0 }));
      check(committed.includes('statement rejected by the test driver'), `commit reports the failed release: ${committed}`);
      const rolledBack = await failureMessage(db.transaction(async () => { failRelease(); await db.utils().lock(key('rollback')); throw new Error('callback failed'); }, { retry: 0 }));
      checkBoth('rollback', rolledBack, 'callback failed', 'statement rejected by the test driver');
      // lock을 미리 풀면 transaction 끝의 RELEASE_LOCK은 0을 돌려준다.
      const notHeld = await failureMessage(db.transaction(async () => {
        await db.utils().lock(key('released'));
        await db.utils().active('lock').session.control('DO RELEASE_LOCK(?)', [key('released')], () => undefined);
      }, { retry: 0 }));
      check(notHeld.includes(`lock ${key('released')} was not held at transaction end`), `a lock released early is reported: ${notHeld}`);
    } finally {
      await db.close();
    }
  } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
  end();
  // transaction 끝의 정리(RELEASE_LOCK)가 실패한 connection은 pool에 돌아가지 않고 버려진다. 실패한 정리 뒤의
  // session 상태는 알 수 없으므로 pool에 돌아가는 connection은 깨끗하거나 버려진다. connection이 하나인 pool의
  // 다음 transaction이 같은 session(CONNECTION_ID)을 받으면 connection이 돌아간 것이고, 풀리지 않은 lock은 그
  // session에 남는다. 깨끗하게 끝난 transaction은 같은 session을 다시 쓴다.
  begin('mysql/failedEndDiscards');
  try {
    const db = await connectBench(process.env.ORM_TEST_MYSQL_DSN, { poolSize: 1 });
    const other = await connectBench(process.env.ORM_TEST_MYSQL_DSN);
    try {
      const key = name => `orm_test.discard.${name}.${process.pid}`;
      const session = () => db.transaction(async () => Number((await db.utils().active('lock').session.control('SELECT CONNECTION_ID()', [], () => undefined)).rows[0][0]), { retry: 0 });
      // free는 다른 connection이 lock을 5초 안에 얻는지다. 끝난 session의 lock은 server가 곧 푼다.
      const free = async name => other.transaction(async () => {
        const control = other.utils().active('lock').session.control.bind(other.utils().active('lock').session);
        const got = Number((await control('SELECT GET_LOCK(?, 5)', [key(name)], () => undefined)).rows[0][0]);
        if (got === 1) await control('DO RELEASE_LOCK(?)', [key(name)], () => undefined);
        return got === 1;
      }, { retry: 0 });
      const failRelease = () => {
        const active = db.utils().active('lock').session;
        const control = active.control.bind(active);
        active.control = (sql, params, done) => sql.startsWith('SELECT RELEASE_LOCK') ? Promise.reject(new Error('statement rejected by the test driver')) : control(sql, params, done);
      };
      const clean = await session();
      await db.transaction(async () => { await db.utils().lock(key('clean')); }, { retry: 0 });
      check(await session() === clean, 'a transaction that ended cleanly keeps its session');
      for (const [name, fail] of [['rollback', true], ['commit', false]]) {
        const before = await session();
        const message = await failureMessage(db.transaction(async () => { failRelease(); await db.utils().lock(key(name)); if (fail) throw new Error('callback failed'); }, { retry: 0 }));
        check(message.includes('statement rejected by the test driver'), `${name} reports the failed release: ${message}`);
        const after = await session();
        check(after !== before, `${name}: session ${before} returned to the pool after its transaction end failed`);
        check(await free(name), `${name}: the lock ${key(name)} is still held after its transaction end failed`);
      }
    } finally {
      await db.close();
      await other.close();
    }
  } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
  end();
  // native rollback, SQLite mode 복원, begin 뒤의 rollback이 실패하면 transaction이 그 오류를 원인과
  // 함께 보고한다. 실제 SQLite는 이 statement를 거부하지 않으므로 connection의 statement 준비가 실패시킨다.
  // rollback은 실제로 끝낸 뒤 실패를 돌려준다.
  begin('sqlite/failedRollback');
  try {
    const db = await connectBench(`sqlite://${join(work, 'transaction-end.sqlite')}`);
    try {
      const state = db.pool.state;
      const native = state.db;
      const statement = state.statement.bind(state);
      let rejects = () => false;
      let rejectRollback = false;
      // ROLLBACK은 실제로 실행한 뒤 실패를 돌려준다.
      state.statement = sql => {
        if (rejects(sql)) throw new Error('statement rejected by the test driver');
        const prepared = statement(sql);
        if (!rejectRollback || sql !== 'ROLLBACK') return prepared;
        return { run: (...values) => { prepared.run(...values); throw new Error('rollback rejected by the test driver'); } };
      };
      rejectRollback = true;
      const rolledBack = await failureMessage(db.transaction(async () => { throw new Error('callback failed'); }, { retry: 0 }));
      checkBoth('rollback', rolledBack, 'callback failed', 'rollback rejected by the test driver');
      rejects = sql => sql === 'PRAGMA query_only = 1';
      const began = await failureMessage(db.transaction(async () => {}, { readOnly: true, retry: 0 }));
      checkBoth('begin', began, 'statement rejected by the test driver', 'rollback rejected by the test driver');
      rejectRollback = false;
      rejects = sql => sql === 'PRAGMA query_only = 0';
      const committed = await failureMessage(db.transaction(async () => {}, { readOnly: true, retry: 0 }));
      check(committed.includes('statement rejected by the test driver'), `commit reports the failed mode reset: ${committed}`);
      const modeRolledBack = await failureMessage(db.transaction(async () => { throw new Error('callback failed'); }, { readOnly: true, retry: 0 }));
      checkBoth('mode reset', modeRolledBack, 'callback failed', 'statement rejected by the test driver');
      check(!native.isTransaction, 'the failed mode reset still rolls the transaction back');
    } finally {
      await db.close();
    }
  } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
  end();
  // 중첩 transaction의 savepoint를 끝내는 ROLLBACK TO SAVEPOINT나 RELEASE SAVEPOINT가 실패하면 callback
  // 오류와 그 오류를 함께 보고하고, 성공한 callback은 실패한 RELEASE SAVEPOINT를 보고한다. 실제 SQLite는
  // 이 statement를 거부하지 않으므로 transaction connection의 control이 실패시킨다.
  begin('sqlite/failedSavepointEnd');
  try {
    const db = await connectBench(`sqlite://${join(work, 'savepoint-end.sqlite')}`);
    try {
      const nested = (rejects, callback) => failureMessage(db.transaction(async () => {
        const session = db.utils().active('transaction').session;
        const control = session.control.bind(session);
        session.control = (sql, params, done) => rejects(sql) ? Promise.reject(new Error('statement rejected by the test driver')) : control(sql, params, done);
        try { return await db.transaction(callback); } finally { session.control = control; }
      }, { retry: 0 }));
      for (const statement of ['ROLLBACK TO SAVEPOINT', 'RELEASE SAVEPOINT']) {
        const failed = await nested(sql => sql.startsWith(statement), async () => { throw new Error('callback failed'); });
        checkBoth(statement, failed, 'callback failed', 'statement rejected by the test driver');
      }
      const released = await nested(sql => sql.startsWith('RELEASE SAVEPOINT'), async () => {});
      check(released.includes('statement rejected by the test driver'), `a successful callback reports the failed release: ${released}`);
      const both = await nested(sql => sql.startsWith('ROLLBACK TO SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT'), async () => { throw new Error('callback failed'); });
      checkBoth('both statements', both, 'callback failed', 'statement rejected by the test driver');
      check(both.split('statement rejected by the test driver').length === 3, `both savepoint statements are reported: ${both}`);
    } finally {
      await db.close();
    }
  } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
  end();
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) process.exitCode = 1;
