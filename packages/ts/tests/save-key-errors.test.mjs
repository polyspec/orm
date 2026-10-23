// save() distinguishes a missing key from every other CONFIG error without a database.
import assert from 'node:assert/strict';
import { caseTest, COMPUTE } from '../../../tests/testcase.mts';
import { Account, CORE, Db, OrmError } from '../dist/index.js';

function fakeDb() {
  const pool = { name: 'sqlite' };
  const db = new Db(pool, 'UTC', {});
  const plans = [];
  const writes = [];
  db.plan = async request => {
    plans.push(request);
    return { plan: { steps: [{ id: 0, role: 'main', sql: request.kind.toUpperCase(), tables: [], bind_slots: [] }] } };
  };
  db.auditFor = async () => async () => {};
  db.runStep = async (_executor, sql) => {
    writes.push(sql);
    return { affected: 1, insertId: 7, rows: [] };
  };
  return { db, plans, writes };
}

caseTest('save creates when the primary key is missing', COMPUTE, async () => {
  const { db, plans, writes } = fakeDb();
  await new Account().connect(db).setName('new').save();
  assert.deepEqual(plans.map(request => request.kind), ['insert']);
  assert.deepEqual(writes, ['INSERT']);
});

caseTest('save updates an explicitly assigned zero key', COMPUTE, async () => {
  const { db, plans, writes } = fakeDb();
  await new Account().connect(db).setSeq(0).setName('zero').save();
  assert.deepEqual(plans.map(request => request.kind), ['update']);
  assert.deepEqual(writes, ['UPDATE']);
});

caseTest('save updates a loaded row by its original key', COMPUTE, async () => {
  const { db, plans, writes } = fakeDb();
  const model = new Account().connect(db).setName('loaded');
  model[CORE].row = { loaded: true, names: [], hidden: new Set(), original: new Map([['seq', 9]]), extra: new Map(), related: new Map(), cascade: new Map(), flat: [] };
  await model.save();
  assert.deepEqual(plans.map(request => request.kind), ['update']);
  assert.deepEqual(writes, ['UPDATE']);
});

caseTest('save preserves an unrelated CONFIG thrown while reading a set key', COMPUTE, async () => {
  const { db, plans, writes } = fakeDb();
  const model = new Account().connect(db).setName('new');
  const [set] = model[CORE].sets;
  const column = set.column;
  const sentinel = new OrmError('CONFIG', 'set column getter failed');
  let first = true;
  Object.defineProperty(set, 'column', {
    configurable: true,
    get() {
      if (first) {
        first = false;
        throw sentinel;
      }
      return column;
    },
  });

  await assert.rejects(model.save(), error => error === sentinel);
  assert.deepEqual(plans, []);
  assert.deepEqual(writes, []);
});
