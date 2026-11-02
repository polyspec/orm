// Shared cases of the request hook (docs/operations/usage.md "Request hook"). They run on a connection where the shared fixture contracts/fixtures/request_hook/request_hook.dbs
// is installed. The SQLite unit test (request_hook.mjs) and the feature coverage (coverage_request_hook.mjs) use them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { codeOf } from './error_code.mjs';

const fixtureText = await readFile(new URL('../../../contracts/fixtures/request_hook/request_hook.dbs', import.meta.url), 'utf8');

const parsed = parseDbspec(fixtureText, {});
assert.deepEqual(parsed.diagnostics, [], 'the fixture parses');
const { manifest } = dbspecManifest([parsed.document]);
const schema = { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
const runtime = registerModel(manifest.manifestText, manifest.manifestHash);
class Item extends Model {}
Item.entity = { model: runtime, entity: runtime.entities.get('hook_item'), create: core => new Item(core) };
class Entry extends Model {}
Entry.entity = { model: runtime, entity: runtime.entities.get('hook_entry'), create: core => new Entry(core) };

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

/**
 * A service scope: adds part = value to the where of the root of every read and of each of its relation queries, nested
 * relations included, as an application scopes every table of a request.
 */
function serviceScope(value) {
  const scope = (query, addParam) => {
    andWhere(query, { column: 'part', op: 'eq', p: addParam(value) });
    for (const relation of query.relations ?? []) scope(relation.query, addParam);
  };
  return (request, addParam) => {
    if (READS.has(request.kind)) scope(request, addParam);
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
  /** The hooked handle derives from the connection: its root is the connection (INT-78). */
  async without_hook(db) {
    const hooked = db.withRequestHook(partFilter('a'));
    assert.equal(hooked.root(), db, 'the hooked handle derives from the connection');
  },

  /** The planned getQuery of a hooked read binds the value that the hook added (PRT-2). */
  async read_filter(db) {
    const a = db.withRequestHook(partFilter('a'));
    const query = await new Item().connect(a).getQuery();
    assert.ok(query.binds.includes('a'), `getQuery binds the value the hook added: ${JSON.stringify(query.binds)}`);
  },

  /**
   * relation() and relations() under a service scope, with the child that has no handle of its own: it reads under the scope
   * of the parent's request. The parent a1 of part a matches the items labeled a1 of parts a and b by label, and under the
   * scope of part a it attaches only the item of part a.
   */
  async relation_scope(db) {
    await item({ part: 'b', label: 'a1' }).connect(db).create();
    for (const [part, label] of [['a', 'a1'], ['b', 'b1']]) await entry({ part, label }).connect(db).create();
    const scoped = db.withRequestHook(serviceScope('a'));
    const parts = rows => rows.map(row => `${row.toArray().part}/${row.toArray().label}`).sort();
    const many = await new Entry().connect(scoped).relations(new Item().matchLabelWithLabel()).gets();
    assert.deepEqual(many.values().map(row => [row.toArray().label, parts(row.getHookItemModels().values())]),
      [['a1', ['a/a1']]], 'relations() under the scope of part a reads the parent and the items of part a');
    const one = await new Entry().connect(scoped).relation(new Item().matchLabelWithLabel()).gets();
    assert.deepEqual(one.values().map(row => [row.toArray().label, row.getHookItemModel()?.toArray().part]),
      [['a1', 'a']], 'relation() under the scope of part a attaches the item of part a');
  },

  /** Part from the hook and no label cover no key: a restore is refused before any statement runs (DIA-161). */
  async restore_no_key(db) {
    await seedDeletedEntries(db);
    const events = [];
    const unsubscribe = db.subscribe(event => events.push(event));
    try {
      await codeOf(entry({ note: 'n3' }).connect(db.withRequestHook(partScope('a'))).restore(), OrmError);
      assert.equal(events.length, 0, `no statement runs: ${events.map(e => e.sql)}`);
    } finally {
      unsubscribe();
    }
  },

  /** The hook reads the bound values of an INSERT, read-only: the value of a label assignment that the model bound. */
  async reads_params(db) {
    let seen;
    let frozen;
    const hooked = db.withRequestHook((request, addParam, params) => {
      if (request.kind === 'insert') {
        const label = request.set.find(assignment => assignment.column === 'label');
        seen = params[label.p];
        frozen = Object.isFrozen(params);
      }
      return request;
    });
    await item({ part: 'r', label: 'read' }).connect(hooked).create();
    assert.equal(seen, 'read', 'the hook reads the value bound to the INSERT assignment');
    assert.equal(frozen, true, 'the parameters the hook reads are read-only');
    assert.ok((await stored(db)).some(([part, label]) => part === 'r' && label === 'read'), 'the hook cannot change the bound value');
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
      assert.equal(await codeOf(new Item().connect(hooked).getCount(), OrmError), 'IR_INVALID', 'a parameter index outside the parameters');
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
};
