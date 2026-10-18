// Shared cases of the request hook (docs/usage.md "Request hook"). They run on a connection where the shared fixture contracts/fixtures/request_hook.dbs
// is installed. The SQLite unit test (request_hook.mjs) and the feature coverage (coverage_request_hook.mjs) use them.
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
class Entry extends Model {}
Entry.entity = { model: runtime, entity: runtime.entities.get('hook_entry'), create: core => new Entry(core) };
class Upsert extends Model {}
Upsert.entity = { model: runtime, entity: runtime.entities.get('hook_upsert'), create: core => new Upsert(core) };

const READS = new Set(['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate']);

/** Adds pred to where with and. An existing where is wrapped in one group. */
function andWhere(query, pred) {
  if (query.where === undefined || query.where.items.length === 0) {
    query.where = { items: [{ pred }] };
    return;
  }
  query.where = { items: [{ group: query.where }, { pred: { ...pred, conn: 'and' } }] };
}

/** A hook that reads only the rows of the same part. A request that is not a read is left as is. */
function partFilter(value) {
  return (request, addParam) => {
    if (READS.has(request.kind)) andWhere(request, { column: 'part', op: 'eq', p: addParam(value) });
    return request;
  };
}

/** Adds part = value to the where of every read and restore. */
function partScope(value) {
  return (request, addParam) => {
    if (request.kind === 'restore' || READS.has(request.kind)) andWhere(request, { column: 'part', op: 'eq', p: addParam(value) });
    return request;
  };
}

function entry(values) {
  const m = new Entry();
  for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
  return m;
}

/** Creates the hook_entry rows (a, x), (b, x) and (a, y) with note n0 through db, soft deletes each and returns their ids by part and label. */
async function seedDeletedEntries(db) {
  const ids = {};
  for (const [part, label] of [['a', 'x'], ['b', 'x'], ['a', 'y']]) {
    const row = await entry({ part, label, note: 'n0' }).connect(db).create();
    ids[part + label] = row.toArray().id;
    await row.delete();
  }
  return ids;
}

/** The [id, note] of every hook_entry row that db reads, which are the rows not deleted. */
async function entryRows(db) {
  return (await new Entry().connect(db).gets()).values().map(row => [row.toArray().id, row.toArray().note]);
}

function item(values) {
  const m = new Item();
  for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
  return m;
}

async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

/** The [part, label] list in label order. */
async function stored(db) {
  const rows = (await new Item().connect(db).gets()).values().map(row => row.toArray());
  return rows.map(row => [row.part, row.label]).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/** Installs the fixture in the database of dsn and runs one case on a connection where a1 and a2 (part a) and b1 (part b) are inserted. */
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
  /** After creating a handle without a hook and a hook handle, the connection reads all rows. */
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

  /** The predicate that the hook added filters read, count, and page. A handle with another value reads other rows with the same plan. */
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

  /** A single-row insert and a multi-row insert write the assignment that the hook added to insert. */
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

  /** The hook sets scope_col on the insert, and the conflict key (scope_col, name) of the upsert is checked after the hook. The caller sets only name, and the update sets hits: the first call inserts and the second updates the row. */
  async upsert_scope(db) {
    const hooked = db.withRequestHook((request, addParam) => {
      if (request.kind === 'insert') request.set.push({ column: 'scope_col', p: addParam('a') });
      return request;
    });
    for (let call = 1; call <= 2; call += 1) {
      const row = new Upsert().connect(hooked);
      row[CORE].setValue('name', 'k');
      const update = new Upsert();
      update[CORE].setValue('hits', 7);
      await row.duplication(update).create();
    }
    const rows = (await new Upsert().connect(db).gets()).values().map(row => row.toArray());
    assert.deepEqual(rows.map(row => [row.scope_col, row.name, row.hits]), [['a', 'k', 7]], 'the stored row holds scope_col a, name k and hits 7');
  },

  /** Update and delete of rows read through a hook handle pass through the hook. The transaction of a hook handle also passes through the hook. */
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

  /** If the hook writes an index outside the parameters, validation rejects it before the statement. */
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

  /** The set names label and the hook's condition names part: together they cover the unique key. */
  async restore_key(db) {
    const ids = await seedDeletedEntries(db);
    const row = await entry({ label: 'x', note: 'n1' }).connect(db.withRequestHook(partScope('a'))).restore();
    const values = row.toArray();
    assert.deepEqual([values.id, values.part, values.label, values.note], [ids.ax, 'a', 'x', 'n1'], 'the restore returns (a, x) with note n1');
    assert.deepEqual(await entryRows(db), [[ids.ax, 'n1']], 'the connection reads only (a, x) with note n1');
  },

  /** The set names the primary key; the hook's condition narrows the restore to the rows of its part. */
  async restore_condition(db) {
    const ids = await seedDeletedEntries(db);
    assert.equal(await codeOf(entry({ id: ids.ay, note: 'n2' }).connect(db.withRequestHook(partScope('b'))).restore()), 'NO_ROWS', 'the restore outside the hook condition');
    assert.deepEqual(await entryRows(db), [], 'the restore outside the hook condition restores no row');
    const values = (await entry({ id: ids.ay, note: 'n2' }).connect(db.withRequestHook(partScope('a'))).restore()).toArray();
    assert.deepEqual([values.id, values.label, values.note], [ids.ay, 'y', 'n2'], 'the restore inside the hook condition returns (a, y) with note n2');
  },

  /** Part from the hook and no label cover no key: IR_INVALID before any statement. */
  async restore_no_key(db) {
    await seedDeletedEntries(db);
    const events = [];
    const unsubscribe = db.subscribe(event => events.push(event));
    try {
      assert.equal(await codeOf(entry({ note: 'n3' }).connect(db.withRequestHook(partScope('a'))).restore()), 'IR_INVALID', 'a restore without a key');
      assert.equal(events.length, 0, `no statement runs: ${events.map(e => e.sql)}`);
    } finally { unsubscribe(); }
  },

  /** The hook scopes the restore to part a and gives the model's label its own value y. */
  async restore_rewritten_key(db) {
    const ids = await seedDeletedEntries(db);
    const scope = partScope('a');
    const hooked = db.withRequestHook((request, addParam) => {
      if (request.kind === 'restore') for (const a of request.set ?? []) if (a.column === 'label') a.p = addParam('y');
      return scope(request, addParam);
    });
    const values = (await entry({ label: 'x', note: 'n4' }).connect(hooked).restore()).toArray();
    assert.deepEqual([values.id, values.label, values.note], [ids.ay, 'y', 'n4'], 'the restore returns (a, y) with note n4');
    assert.deepEqual(await entryRows(db), [[ids.ay, 'n4']], 'the connection reads only (a, y) with note n4');
  },

  /** The hook gives the model's label its own value y and sets part a after it, with no where parameter. */
  async restore_rewritten_key_set_scope(db) {
    const ids = await seedDeletedEntries(db);
    const hooked = db.withRequestHook((request, addParam) => {
      if (request.kind === 'restore') {
        for (const a of request.set ?? []) if (a.column === 'label') a.p = addParam('y');
        request.set = [...(request.set ?? []), { column: 'part', p: addParam('a') }];
      }
      return request;
    });
    const values = (await entry({ label: 'x', note: 'n6' }).connect(hooked).restore()).toArray();
    assert.deepEqual([values.id, values.label, values.note], [ids.ay, 'y', 'n6'], 'the restore returns (a, y) with note n6');
    assert.deepEqual(await entryRows(db), [[ids.ay, 'n6']], 'the connection reads only (a, y) with note n6');
  },

  /** The hook puts part a first in the set; the model's label completes the unique key. */
  async restore_hook_set_key(db) {
    const ids = await seedDeletedEntries(db);
    const hooked = db.withRequestHook((request, addParam) => {
      if (request.kind === 'restore') request.set = [{ column: 'part', p: addParam('a') }, ...(request.set ?? [])];
      return request;
    });
    const values = (await entry({ label: 'x', note: 'n5' }).connect(hooked).restore()).toArray();
    assert.deepEqual([values.id, values.part, values.note], [ids.ax, 'a', 'n5'], 'the restore returns (a, x) with note n5');
    assert.deepEqual(await entryRows(db), [[ids.ax, 'n5']], 'the connection reads only (a, x) with note n5');
  },

  /** The hook reads the bound values of the request, read-only: the value of a predicate that the model bound. */
  async reads_params(db) {
    let seen;
    let frozen;
    const hooked = db.withRequestHook((request, addParam, params) => {
      if (request.kind === 'all') {
        seen = params[request.where.items[0].pred.p];
        frozen = Object.isFrozen(params);
      }
      return request;
    });
    await new Item().connect(hooked).label('a2').gets();
    assert.equal(seen, 'a2', 'the hook reads the value bound to the predicate');
    assert.equal(frozen, true, 'the parameters the hook reads are read-only');
  },
};
