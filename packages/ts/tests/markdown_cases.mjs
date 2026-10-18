// The cases of the markdown conformance (tests/markdown/cases.json) as functions of the TypeScript client. Each takes a served
// corpus (markdown_conformance.mjs, the flowmark server) or a connection (ir_answers.mjs, the IR answers of
// contracts/fixtures/ir_answers.json) and returns the result that tests/markdown/README.md defines.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OrmError, StyledValue } from '../dist/index.js';
import { Logs, People, Tasks, connect } from '../dist/models/markdown_fixture/models.js';
/** The error that the callback throws to roll back the transaction. */
export const stop = new Error('stop');

/** A function that runs the case for each id in cases.json and returns the result value that README defines. A thrown OrmError becomes {"error": code} with its code. */
export const conformanceCases = {
  insert_one: async s => {
    const m = await new People().connect(s.db).setName('Ann').setEmail('ann@example.com').setAge(30).setScore('1.50').create();
    return { id: m.getId() };
  },
  insert_rows: async s => {
    const bob = new People().setName('Bob').setEmail('bob@example.com').setAge(25).setScore('2.00');
    const cara = new People().setName('Cara').setEmail(null).setAge(null).setScore('0.50');
    return new People().connect(s.db).creates([bob, cara]);
  },
  insert_rows_tasks: async s => new Tasks().connect(s.db).creates([
    new Tasks().setOwner('P1').setTitle('write spec').setPoints(3).setDue('2026-10-01'),
    new Tasks().setOwner('P1').setTitle('review').setPoints(5).setDue(null),
    new Tasks().setOwner('P2').setTitle('ship').setPoints(8).setDue('2026-10-05'),
  ]),
  insert_identity: async s => {
    const m = await new Logs().connect(s.db).setTask('T1').setNote('started').create();
    return { id: m.getId() };
  },
  one: async s => (await new People().connect(s.db).removeAllColumns().addColumnName().addColumnEmail().addColumnAge().addColumnActive().addColumnScore().id('P1').get()).toArray(),
  one_no_rows: async s => new People().connect(s.db).id('P9').get(),
  all: async s => (await new People().connect(s.db).removeAllColumns().addColumnName().addColumnAge().orderByNameDesc().gets()).toArray(),
  count: async s => new Tasks().connect(s.db).owner('P1').getCount(),
  group_count: async s => (await new Tasks().connect(s.db).groupByOwner().orderByOwnerAsc().getsCount()).toArray(),
  group_count_no_rows: async s => (await new Tasks().connect(s.db).owner('P9').groupByOwner().orderByOwnerAsc().getsCount()).toArray(),
  sum: async s => new Tasks().connect(s.db).sumPoints().getSum(),
  avg: async s => new People().connect(s.db).avgAge().getAvg(),
  paginate: async s => {
    const page = await new People().connect(s.db).removeAllColumns().addColumnName().orderByNameAsc().getsPage(2, 2);
    return { items: page.items.toArray(), total_count: page.totalCount, total_pages: page.totalPages };
  },
  join: async s => (await new Tasks().connect(s.db).removeAllColumns().addColumnTitle()
    .joinOwnerWithId(new People().removeAllColumns().addColumnName())
    .orderByTitleAsc().gets()).toArray(),
  relation_many: async s => (await new People().connect(s.db).removeAllColumns().addColumnName()
    .relations(new Tasks().removeAllColumns().addColumnDue().matchIdWithOwner().orderByTitleAsc())
    .id('P1').get()).toArray(),
  relation_one: async s => (await new Tasks().connect(s.db).removeAllColumns().addColumnTitle()
    .relation(new People().removeAllColumns().addColumnName().matchOwnerWithId())
    .id('T3').get()).toArray(),
  update: async s => {
    const m = await new People().connect(s.db).id('P2').get();
    await m.setAge(26).update();
    return (await new People().connect(s.db).removeAllColumns().addColumnAge().id('P2').get()).toArray();
  },
  update_optimistic_conflict: async s => {
    const stale = await new People().connect(s.db).id('P2').get();
    const fresh = await new People().connect(s.db).id('P2').get();
    await fresh.setName('Bobby').update();
    return stale.setAge(27).update(true);
  },
  insert_on_duplicate: async s => {
    const m = await new People().connect(s.db).setName('Ann B').setEmail('ann@example.com')
      .duplication(new People().setName('Ann B')).create();
    const read = await new People().connect(s.db).id('P1').get();
    return { created: m.getId(), name: read.getName() };
  },
  delete: async s => {
    const m = await new Tasks().connect(s.db).id('T2').get();
    await m.delete();
    return new Tasks().connect(s.db).getCount();
  },
  delete_referenced: async s => {
    const m = await new Tasks().connect(s.db).id('T1').get();
    return m.delete();
  },
  soft_delete: async s => {
    const m = await new People().connect(s.db).id('P3').get();
    await m.delete();
    return new People().connect(s.db).getCount();
  },
  restore: async s => {
    const m = await new People().connect(s.db).setId('P3').restore();
    const n = await new People().connect(s.db).getCount();
    return { id: m.getId(), name: m.getName(), count: n };
  },
  transaction_commit: async s => {
    await s.db.transaction(async () => { await new Logs().setTask('T3').setNote('committed').create(); });
    return new Logs().connect(s.db).getCount();
  },
  transaction_rollback: async s => {
    const error = await s.db.transaction(async () => {
      await new Logs().setTask('T3').setNote('rolled back').create();
      throw stop;
    }).then(() => undefined, e => e);
    if (error !== stop) throw new Error(`the transaction ended with ${error}, not its callback's error`);
    return new Logs().connect(s.db).getCount();
  },
  savepoint_rollback: async s => {
    await s.db.transaction(async () => {
      await new Logs().setTask('T3').setNote('outer').create();
      const error = await s.db.transaction(async () => {
        await new Logs().setTask('T3').setNote('inner').create();
        throw stop;
      }).then(() => undefined, e => e);
      if (error !== stop) throw new Error(`the savepoint ended with ${error}, not its callback's error`);
    });
    const rows = await new Logs().connect(s.db).orderByIdAsc().gets();
    return rows.values().map(m => m.getNote());
  },
  read_only_write: async s => s.db.transaction(async () => { await new Logs().setTask('T3').setNote('read only').create(); }, { readOnly: true }),
  lock_update: async s => s.db.transaction(async () => (await new People().connect(s.db).removeAllColumns().id('P1').forUpdate().get()).toArray()),
  lock_nowait: async s => s.db.transaction(async () => { await new People().connect(s.db).id('P1').forUpdateNoWait().get(); }),
  get_query: async s => new People().connect(s.db).getQuery(),
  isolation: async s => s.db.transaction(async () => undefined, { isolation: 'serializable' }),
  // A transaction that reads P1 and writes its own name back, with retry options: the commit's code (null when it
  // commits) and how many times the callback ran. WRITE_CONFLICT is never retried, DEADLOCK is
  // (contracts/fixtures/ir_answers.json).
  transaction_retry_commit: async s => {
    let runs = 0;
    const error = await s.db.transaction(async () => {
      runs += 1;
      const m = await new People().id('P1').get();
      await m.setName(m.getName()).update();
    }, { retry: 3 }).then(() => undefined, e => e);
    if (error !== undefined && !(error instanceof OrmError)) throw error;
    return { error: error === undefined ? null : error.code, runs };
  },
  write_conflict: async s => {
    const error = await s.db.transaction(async () => {
      const m = await new People().id('P1').get();
      await m.setName('Ann C').update();
      // Edit outside the engine: changes the file the transaction will write before the commit.
      const file = path.join(s.dir, 'people.flowmark.md');
      const text = await readFile(file, 'utf8');
      if (!text.includes('Cara')) throw new Error(`${file} holds no Cara to edit:\n${text}`);
      await writeFile(file, text.replace('Cara', 'Carol'));
    }).then(() => undefined, e => e);
    const read = await new People().connect(s.db).id('P1').get();
    return { error: error instanceof OrmError ? error.code : String(error), name: read.getName() };
  },
  connect_corpus_mismatch: async s => (await connect(s.dsn('other', s.token))).close(),
  connect_token_mismatch: async s => (await connect(s.dsn(s.corpus, '0'.repeat(32)))).close(),
};

/** The result, written as JSON and read back: it has the same form as expect in cases.json. The TypeScript model holds dates as the YYYY-MM-DD text that README
 * "Results" defines. */
export function normalize(value) {
  if (value instanceof StyledValue) throw new Error('a case result holds a styled value, which has no JSON form here');
  return JSON.parse(JSON.stringify(value ?? null));
}
