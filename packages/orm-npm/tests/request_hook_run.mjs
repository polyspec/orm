// request hook(docs/usage.md "Request hook")의 공유 case 다. 공유 fixture contracts/fixtures/request_hook.dbs 를
// 설치한 연결에서 실행한다. SQLite unit test(request_hook.mjs)와 feature coverage(coverage_request_hook.mjs)가 쓴다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

const fixtureText = await readFile(new URL('../../../contracts/fixtures/request_hook.dbs', import.meta.url), 'utf8');

const parsed = parseDbspec(fixtureText, {});
assert.deepEqual(parsed.diagnostics, [], 'the fixture parses');
const { manifest } = dbspecManifest([parsed.document]);
const schema = { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
const runtime = registerModel(manifest.manifestText, manifest.manifestHash);
class Item extends Model {}
Item.entity = { model: runtime, entity: runtime.entities.get('hook_item'), create: core => new Item(core) };

const READS = new Set(['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate']);

/** where 에 pred 를 and 로 더한다. 이미 있는 where 는 group 하나로 감싼다. */
function andWhere(query, pred) {
  if (query.where === undefined || query.where.items.length === 0) {
    query.where = { items: [{ pred }] };
    return;
  }
  query.where = { items: [{ group: query.where }, { pred: { ...pred, conn: 'and' } }] };
}

/** 같은 part 의 행만 읽는 hook 이다. 읽기가 아닌 request 는 그대로 둔다. */
function partFilter(value) {
  return (request, addParam) => {
    if (READS.has(request.kind)) andWhere(request, { column: 'part', op: 'eq', p: addParam(value) });
    return request;
  };
}

function item(values) {
  const m = new Item();
  for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
  return m;
}

async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

/** label 순서의 [part, label] 목록이다. */
async function stored(db) {
  const rows = (await new Item().connect(db).gets()).values().map(row => row.toArray());
  return rows.map(row => [row.part, row.label]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** dsn 의 database 에 fixture 를 설치하고 a1, a2(part a)와 b1(part b)을 넣은 연결로 case 하나를 실행한다. */
export async function runOn(dsn, step, run) {
  const db = await Db.connect(dsn);
  try {
    step('install the fixture');
    await db.utils().schema().install(schema);
    for (const [part, label] of [['a', 'a1'], ['a', 'a2'], ['b', 'b1']]) await item({ part, label }).connect(db).create();
    await run(db);
  } finally { await db.close(); }
}

export const cases = {
  /** hook 없는 handle 과 hook handle 을 만든 뒤의 연결은 모든 행을 읽는다. */
  async without_hook(db) {
    assert.equal(await new Item().connect(db).getCount(), 3, 'the connection counts every row');
    const hooked = db.withRequestHook(partFilter('a'));
    assert.equal(hooked.root(), db, 'the hooked handle derives from the connection');
    assert.equal(db.withSignal(new AbortController().signal).requestHook, undefined, 'a signal handle of the connection has no hook');
    assert.deepEqual(await stored(db), [['a', 'a1'], ['a', 'a2'], ['b', 'b1']], 'the connection reads every row after a hooked handle was derived');
    assert.equal(await new Item().connect(db).getCount(), 3, 'the connection still counts every row');
    const page = await new Item().connect(db).getsPage(1, 10);
    assert.equal(page.totalCount, 3, 'the connection pages every row');
  },

  /** hook 이 더한 predicate 가 read, count, page 를 거른다. 다른 값의 handle 은 같은 plan 으로 다른 행을 읽는다. */
  async read_filter(db) {
    const a = db.withRequestHook(partFilter('a'));
    assert.deepEqual(await stored(a), [['a', 'a1'], ['a', 'a2']], 'the hook filters a read');
    assert.equal(await new Item().connect(a).getCount(), 2, 'the hook filters a count');
    const page = await new Item().connect(a).getsPage(1, 10);
    assert.equal(page.totalCount, 2, 'the hook filters the count of a page');
    assert.equal(page.items.values().length, 2, 'the hook filters the rows of a page');
    const b = db.withRequestHook(partFilter('b'));
    assert.deepEqual(await stored(b), [['b', 'b1']], 'a handle with another value reads its rows');
    const query = await new Item().connect(b).getQuery();
    assert.ok(query.binds.includes('b'), `getQuery binds the value the hook added: ${JSON.stringify(query.binds)}`);
    const signalled = a.withSignal(new AbortController().signal);
    assert.equal(await new Item().connect(signalled).getCount(), 2, 'a signal handle of a hooked handle keeps the hook');
  },

  /** insert 에 hook 이 더한 assignment 를 한 행 insert 와 여러 행 insert 가 쓴다. */
  async insert_assign(db) {
    const hooked = db.withRequestHook((request, addParam) => {
      if (request.kind !== 'insert') return request;
      request.set.push({ column: 'part', p: addParam('h') });
      for (const row of request.rows ?? []) row.push(addParam('h'));
      return request;
    });
    await item({ label: 'h1' }).connect(hooked).create();
    const inserted = await new Item().connect(hooked).creates([item({ label: 'h2' }), item({ label: 'h3' })]);
    assert.equal(inserted, 2, 'the bulk insert writes two rows');
    const rows = (await stored(db)).filter(([, label]) => label.startsWith('h'));
    assert.deepEqual(rows, [['h', 'h1'], ['h', 'h2'], ['h', 'h3']], 'the single and the bulk insert write the assigned part');
  },

  /** hook handle 로 읽은 행의 update 와 delete 는 hook 을 지난다. hook handle 의 transaction 도 hook 을 지난다. */
  async loaded_row_writes(db) {
    const kinds = [];
    const hooked = db.withRequestHook((request, addParam) => {
      kinds.push(request.kind);
      if (request.kind === 'update' || request.kind === 'delete') andWhere(request, { column: 'part', op: 'eq', p: addParam('none') });
      return request;
    });
    const row = (await new Item().connect(hooked).gets()).values().find(m => m.toArray().label === 'a1');
    assert.ok(row !== undefined, 'the hooked handle reads a1');
    row[CORE].setValue('label', 'changed');
    await row.update();
    assert.ok(kinds.includes('update'), `the update of the loaded row passes the hook: ${kinds}`);
    assert.deepEqual((await stored(db)).map(([, label]) => label), ['a1', 'a2', 'b1'], 'the predicate of the hook keeps the update from the row');
    await row.delete();
    assert.ok(kinds.includes('delete'), `the delete of the loaded row passes the hook: ${kinds}`);
    assert.equal(await new Item().connect(db).getCount(), 3, 'the predicate of the hook keeps the delete from the row');
    kinds.length = 0;
    const count = await hooked.transaction(() => new Item().getCount());
    assert.equal(count, 3, 'the read of the transaction counts every row');
    assert.deepEqual(kinds, ['count'], 'a model without a connection in a transaction of the hooked handle passes the hook');
  },

  /** hook 이 parameter 밖의 index 를 쓰면 validation 이 statement 전에 거부한다. */
  async invalid_param(db) {
    const events = [];
    const unsubscribe = db.subscribe(event => events.push(event));
    try {
      const hooked = db.withRequestHook(request => {
        andWhere(request, { column: 'part', op: 'eq', p: request.n_params + 5 });
        return request;
      });
      assert.equal(await codeOf(new Item().connect(hooked).getCount()), 'IR_INVALID', 'a parameter index outside the parameters');
      assert.equal(events.length, 0, `no statement runs: ${events.map(e => e.sql)}`);
    } finally { unsubscribe(); }
  },
};
