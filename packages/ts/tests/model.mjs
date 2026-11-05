// Model integration test on SQLite, MySQL and PostgreSQL. ORM_TEST_MYSQL_DSN
// and ORM_TEST_POSTGRES_DSN must be set, e.g.
//   ORM_TEST_MYSQL_DSN='mysql://root@localhost/orm_ts_test?socket=/tmp/mysql.sock'
//   ORM_TEST_POSTGRES_DSN='postgres:///orm_ts_test?host=/tmp'
// Every case that installs the schema or checks an empty database runs on a
// case database of its own (case-database.mjs), created on those servers and
// dropped when the case ends; the databases the DSNs name are not changed.
//
// Each case is one node:test test named by its parity id; node --test-name-pattern selects one.
// Usage: node packages/ts/tests/model.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Account, Author, CompositeAccount, CompositeMembership, OrmError, Service,
  ServiceMember, ServiceRegion, StyledValue, User, connect as connectBench,
} from '../dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { DATABASE, caseTest, withTemporaryDirectory } from '../../../tests/testcase.mts';
import { installBench } from './bench-set.mjs';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';
const root = new URL('../../..', import.meta.url).pathname;

let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function code(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

/** The DSN of a server dialect; a database test never skips, so a missing one fails the case. */
function dsnOf(dialect) {
  const name = `ORM_TEST_${dialect.toUpperCase()}_DSN`;
  if (!process.env[name]) throw new Error(`${name} is required; run make orm-test-servers, which starts the databases and writes it; run the test through its make target, which reads the environment of make orm-test-servers`);
  return process.env[name];
}

/**
 * Registers the case name with node:test and runs body(dialect, step) for each of its dialects. A failed check writes its
 * FAIL <dialect>/<name> line and the case goes on; the case fails once at its end. Each dialect has the DATABASE deadline:
 * it installs the schema and runs up to several hundred statements. A case past its deadline ends the process through
 * execute() of tests/testcase.mts.
 */
function modelCase(name, dialects, body) {
  caseTest(name, DATABASE * dialects.length, async ({ step }) => {
    const before = failures;
    for (const dialect of dialects) {
      current = `${dialect}/${name}`;
      try {
        if (dialect !== 'sqlite') dsnOf(dialect);
        await body(dialect, step);
      } catch (error) { failures++; console.error(`FAIL ${current}:`, error); }
    }
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
}
const DIALECTS = ['sqlite', 'mysql', 'postgres'];

/** Installs the schema twice through a connection to the new case database, which must be empty first. */
async function install(dsn) {
  const db = await connect(dsn);
  try {
    check(await db.utils().schema().empty(), 'schema().empty() before install');
    await installBench(db);
    await installBench(db);
  } finally { await db.close(); }
}

// A datetime parameter is its canonical text, YYYY-MM-DD HH:MM:SS in UTC (docs/spec/interfaces.md).
const start = Date.UTC(2026, 0, 2, 3, 4, 5);
const datetime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const hours = h => datetime(start + h * 3_600_000);

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
 * Takes the row locks by updating every row of the table in an open transaction on another connection (MySQL, PostgreSQL).
 * The returned function rolls back that transaction and closes the connection; a second call does nothing.
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

// Requirements: DSL-60, PLN-6, PLN-7, PLN-23, PLN-28, PLN-34, PLN-37, PLN-38, PLN-39.
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
  check(await new Author().connect(db).gtStartDt(datetime(start + 90 * 60_000)).getCount() === 2, 'time compare');
  const one = await new Author().connect(db).getByName('gamma');
  check(one !== null && one.getReadCount() === 20, 'getBy');
  check(await new Author().connect(db).getByName('missing') === null, 'get without a row returns null');
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

// Requirements: PLN-8, PLN-9, PLN-14.
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
  ], 3);
  check(inserted === 3, `creates: ${inserted}`);
  const pairs = await new CompositeMembership().connect(db).tupleTenantIdWithAccountId([[1, 10], [2, 10]]).getCount();
  check(pairs === 2, `tuple: ${pairs}`);
}

// Requirements: DSL-115, DSL-155, PLN-12, PLN-27.
async function writes(db) {
  const f = await seed(db);
  const b = await new Author().connect(db).getBySeq(f.authors[0].getSeq());
  await b.setName('renamed').plusReadCount(5).update(true);
  const again = await new Author().connect(db).getBySeq(b.getSeq());
  check(again.getName() === 'renamed' && again.getReadCount() === 5, `update: ${again.getName()} ${again.getReadCount()}`);
  // Requirements: DSL-155.
  check(await code(b.setName('stale').update(true)) === 'CONFIG', 'optimistic update without a fresh version');
  await again.setName('again').update();
  await b.setName('x').update();
  const setter = new Account();
  check(setter.setName('stored') === setter, 'a setter returns its model');
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

// Requirements: COD-20.
async function styledStates(db) {
  const fixture = JSON.parse(await readFile(join(root, 'contracts/fixtures/styled_column_states.json'), 'utf8'));
  const cases = Object.fromEntries(fixture.cases.map(entry => [entry.id, entry]));
  const f = await seed(db);
  const seq = f.authors[0].getSeq();
  const row = await new Author().connect(db).addAllColumns().getBySeq(seq);
  check(row.getJsonSetting().kind === 'sql-null', 'SQL NULL getter');
  const partial = await new Author().connect(db).removeAllColumns().addColumnName().getBySeq(seq);
  check(await code(Promise.resolve().then(() => partial.getJsonSetting())) === cases.unselected.getter_error, 'unselected getter');

  await row.setJsonSetting(StyledValue.value(parseJson('null')))
    .setJsonsTags(StyledValue.value(parseJson('null')))
    .setSerializeData(StyledValue.value(null)).update();
  const loaded = await new Author().connect(db).addAllColumns().getBySeq(seq);
  for (const getter of ['getJsonSetting', 'getJsonsTags', 'getSerializeData']) {
    check(loaded[getter]().kind === 'value', `${getter} of an encoded null`);
  }
}

// Requirements: COD-8, PLN-44, INT-60, INT-75, INT-131.
function connect(dsn) {
  return connectBench(dsn, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key' });
}

/**
 * A batch that is not a positive integer is CONFIG before any statement (docs/spec/protocol.md "Relation steps"). The
 * recipes write batches that every runtime can hold; a negative or a fractional number and NaN reach the argument only
 * where the type of the language lets them.
 */
async function insertParts(db) {
  const inserts = [];
  const unsubscribe = db.subscribe(event => { if (event.sql.startsWith('INSERT INTO')) inserts.push(event); });
  try {
    const few = [new Service().setName('refused-a'), new Service().setName('refused-b')];
    for (const size of [-1, 1.5, Number.NaN]) {
      check(await code(new Service().connect(db).creates(few, size)) === 'CONFIG', `batch ${size} is CONFIG`);
    }
    check(inserts.length === 0, `refused creates ran ${inserts.length} inserts, want none`);
  } finally { unsubscribe(); }
}

const cases = { conditions, columnsAndSubqueries, writes, styledStates, insertParts };

/**
 * Runs body(dsn, database) on a new case database for the dialect, and drops it when done. A SQLite DSN has a
 * busy_timeout. A failure of the body or of the database drop fails the dialect of the case.
 */
function inCaseDatabase(dialect, step, body) {
  return withCaseDatabase(dialect, step, database =>
    body(dialect === 'sqlite' ? `${database.dsn}?_pragma=busy_timeout(5000)` : database.dsn, database));
}

/** Runs fn(db, dsn) on a new case database of the dialect with the schema installed. */
function installed(fn) {
  return (dialect, step) => inCaseDatabase(dialect, step, async dsn => {
    await install(dsn);
    const db = await connect(dsn);
    try { await fn(db, dsn, dialect); } finally { await db.close(); }
  });
}

const failureMessage = async promise => { try { await promise; return 'no error'; } catch (error) { return String(error?.message); } };
// Checks that the message is a ROLLBACK that includes both the cause and the error at the end of the transaction.
const checkBoth = (what, message, cause, end) => check(message.startsWith('ROLLBACK: transaction failed (') && message.includes(cause) && message.includes(`and rollback failed (`) && message.includes(end), `${what} reports the cause and the failed transaction end: ${message}`);

for (const [name, fn] of Object.entries(cases)) modelCase(name, DIALECTS, installed(fn));
// Requirements: CFG-9.
modelCase('cancellation', DIALECTS, installed(async (db, dsn, dialect) => {
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
}));
// If the MySQL local value reset at the end of a transaction fails, commit and rollback report that error.
// A MySQL user variable survives COMMIT and ROLLBACK (mysql.context.user_variable_session_scope).
// The real server does not reject the reset, so the control of the transaction connection makes only the reset fail.
// Requirements: INT-72.
modelCase('failedLocalReset', ['mysql'], async () => {
  const db = await connectBench(dsnOf('mysql'));
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
});
// If MySQL RELEASE_LOCK at the end of a transaction fails or cannot release the lock, commit and rollback
// report that error, and that connection is not returned to the pool (mysql/failedEndDiscards). The real server does not reject RELEASE_LOCK, so
// the control of the transaction connection makes only RELEASE_LOCK fail.
// Requirements: INT-72.
modelCase('failedLockRelease', ['mysql'], async () => {
  const db = await connectBench(dsnOf('mysql'));
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
  } finally {
    await db.close();
  }
});
// A connection whose cleanup at the end of a transaction (RELEASE_LOCK) fails is discarded and not returned to the pool. After a failed cleanup,
// the session state is unknown, so a connection returned to the pool is either clean or discarded. In a pool with one connection,
// if the next transaction gets the same session (CONNECTION_ID), the connection came back, and a lock that was not released stays
// on that session. A transaction that ended cleanly reuses the same session.
// Requirements: INT-72.
modelCase('failedEndDiscards', ['mysql'], async () => {
  const db = await connectBench(dsnOf('mysql'), { poolSize: 1 });
  const other = await connectBench(dsnOf('mysql'));
  try {
    const key = name => `orm_test.discard.${name}.${process.pid}`;
    const session = () => db.transaction(async () => Number((await db.utils().active('lock').session.control('SELECT CONNECTION_ID()', [], () => undefined)).rows[0][0]), { retry: 0 });
    // free checks whether another connection gets the lock within 5 seconds. The server soon releases the lock of an ended session.
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
});
// If the native rollback, the SQLite mode restore, or the rollback after begin fails, the transaction reports that error
// together with its cause. The real SQLite does not reject this statement, so the connection's statement preparation makes it fail.
// The rollback returns the failure after actually finishing.
// Requirements: INT-72.
modelCase('failedRollback', ['sqlite'], () => withTemporaryDirectory('orm-ts-model-', async work => {
  const db = await connectBench(`sqlite://${join(work, 'transaction-end.sqlite')}`);
  try {
    const state = db.pool.state;
    const native = state.db;
    const statement = state.statement.bind(state);
    let rejects = () => false;
    let rejectRollback = false;
    // ROLLBACK returns the failure after actually running.
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
}));
// If ROLLBACK TO SAVEPOINT or RELEASE SAVEPOINT, which ends a nested transaction's savepoint, fails, the callback
// reports its error together with that error, and a successful callback reports the failed RELEASE SAVEPOINT. The real SQLite
// does not reject this statement, so the control of the transaction connection makes it fail.
// Requirements: DIA-181, PLN-17.
modelCase('failedSavepointEnd', ['sqlite'], () => withTemporaryDirectory('orm-ts-model-', async work => {
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
}));
