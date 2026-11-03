// Shared cases of the request hook (docs/operations/usage.md "Request hook"). They run on a connection where the shared fixture contracts/fixtures/request_hook/request_hook.dbs
// is installed. The SQLite unit test (request_hook.mjs) uses them. The recipe request_hook runs every other case on each database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORE, Db, Model, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { andWhere } from './recipe.mjs';

const fixtureText = await readFile(new URL('../../../contracts/fixtures/request_hook/request_hook.dbs', import.meta.url), 'utf8');

const parsed = parseDbspec(fixtureText, {});
assert.deepEqual(parsed.diagnostics, [], 'the fixture parses');
const { manifest } = dbspecManifest([parsed.document]);
const schema = { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
const runtime = registerModel(manifest.manifestText, manifest.manifestHash);
class Item extends Model {}
Item.entity = { model: runtime, entity: runtime.entities.get('hook_item'), create: core => new Item(core) };

const READS = new Set(['one', 'all', 'count', 'group_count', 'sum', 'avg', 'paginate']);

/** A hook that reads only the rows of the same part. A request that is not a read is left as is. */
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

};
