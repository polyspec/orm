// The cases of the markdown conformance (tests/markdown/cases.json) as functions of the TypeScript client. Each takes a served
// corpus (markdown_conformance.mjs, the flowmark server) or a connection (ir_answers.mjs, the IR answers of
// contracts/fixtures/ir_answers.json) and returns the result that tests/markdown/README.md defines.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OrmError, StyledValue, orm } from '../dist/index.js';
import { Logs, People, Tasks, connect } from '../dist/models/markdown_fixture/models.js';
/** The error that the callback throws to roll back the transaction. */
export const stop = new Error('stop');

const refusedDir = fileURLToPath(new URL('../../../tests/markdown/refused/', import.meta.url));

/** The orm code of the error that the promise rejects with, or null when it resolves; another error is thrown again. */
async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof OrmError) return error.code;
    throw error;
  }
}

/** The code that flowmark install prints when it refuses tests/markdown/refused/<name>.dbs, {error: code}; an install that succeeds is {error: null}. */
async function refusedInstall(s, name) {
  const root = await mkdtemp(path.join(tmpdir(), 'orm-markdown-refused-'));
  try {
    const dir = path.join(root, name);
    await mkdir(path.join(dir, 'dbspec'), { recursive: true });
    await writeFile(path.join(dir, 'dbspec', `${name}.dbs`), await readFile(path.join(refusedDir, `${name}.dbs`)));
    try {
      await promisify(execFile)(s.bin, ['install', dir]);
      return { error: null };
    } catch (error) {
      const m = /^flowmark install: ([A-Z_]+):/m.exec(`${error.stdout ?? ''}${error.stderr ?? ''}`);
      if (m === null) throw new Error(`flowmark install ${dir}: ${error.message}, without a refusal code`);
      return { error: m[1] };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A function that runs the case for each id in cases.json and returns the result value that README defines. A thrown OrmError becomes {"error": code} with its code. */
export const conformanceCases = {
  insert_one: async s => {
    const m = await new People().connect(s.db).setName('Ann').setEmail('ann@example.com').setAge(30).setScore('1.50').create();
    return { id: m.getId() };
  },
  insert_rows: async s => {
    const bob = new People().setName('Bob').setEmail('bob@example.com').setAge(25).setScore('2.00');
    const cara = new People().setName('Cara').setEmail(null).setAge(null).setScore('0.50');
    return new People().connect(s.db).creates([bob, cara], 2);
  },
  insert_rows_tasks: async s => new Tasks().connect(s.db).creates([
    new Tasks().setOwner('P1').setTitle('write spec').setPoints(3).setDue('2026-10-01'),
    new Tasks().setOwner('P1').setTitle('review').setPoints(5).setDue(null),
    new Tasks().setOwner('P2').setTitle('ship').setPoints(8).setDue('2026-10-05'),
  ], 3),
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
  // NULL sorts before every value ascending and after every value descending (docs/spec/dialects.md DIA-156).
  order_nulls: async s => ({
    asc: (await new People().connect(s.db).removeAllColumns().addColumnAge().orderByAgeAsc().gets()).toArray(),
    desc: (await new People().connect(s.db).removeAllColumns().addColumnAge().orderByAgeDesc().gets()).toArray(),
  }),
  // orderByRandom is supported and not seeded, so the case answers the keys sorted (DIA-182).
  order_random: async s => (await new People().connect(s.db).removeAllColumns().orderByRandom().gets()).values().map(m => m.getId()).sort(),
  // The key t3 equals T3 without regard to case: a plain insert is DUPLICATE_KEY, and an on_duplicate insert meets T3,
  // which keeps its key (DIA-164).
  primary_key_case: async s => {
    const duplicate = await codeOf(new Tasks().connect(s.db).setId('t3').setOwner('P2').setTitle('dup').setPoints(1).create());
    await new Tasks().connect(s.db).setId('t3').setOwner('P2').setTitle('ship it').setPoints(8)
      .duplication(new Tasks().setTitle('ship it')).create();
    const met = (await new Tasks().connect(s.db).removeAllColumns().addColumnTitle().id('T3').get()).toArray();
    return { duplicate, met, count: await new Tasks().connect(s.db).getCount() };
  },
  // Two columns compared with a list of value groups, IN and NOT IN (DIA-168).
  tuple_in: async s => {
    const pairs = [['T1', 'P1'], ['T3', 'P1']];
    return {
      in: (await new Tasks().connect(s.db).removeAllColumns().tupleIdWithOwner(pairs).orderByIdAsc().gets()).toArray(),
      not_in: (await new Tasks().connect(s.db).removeAllColumns().neTupleIdWithOwner(pairs).orderByIdAsc().gets()).toArray(),
    };
  },
  // The sum of each person's task points as a scalar Sub aggregate, and the owners of a task through an IN subquery (DIA-168).
  subquery_aggregate: async s => {
    const rows = await new People().connect(s.db).removeAllColumns()
      .addColumnTaskPoints(p => new Tasks().sumPoints().ownerEqId(p)).orderByIdAsc().gets();
    const owners = await new People().connect(s.db).removeAllColumns().id(new Tasks().addColumnOwner()).orderByIdAsc().gets();
    return { sums: rows.values().map(m => [m.getId(), m.getTaskPoints() === null ? null : Number(m.getTaskPoints())]), owners: owners.toArray() };
  },
  // The title of each person's first task, a column subquery with limit 1 and an order by the primary key; without the
  // limit it is IR_INVALID (DIA-169).
  scalar_column_subquery: async s => {
    const rows = await new People().connect(s.db).removeAllColumns()
      .addColumnFirstTask(p => new Tasks().removeAllColumns().addColumnTitle().ownerEqId(p).orderByIdAsc().limit(0, 1)).orderByIdAsc().gets();
    const unlimited = await codeOf(new People().connect(s.db).removeAllColumns()
      .addColumnFirstTask(p => new Tasks().removeAllColumns().addColumnTitle().ownerEqId(p).orderByIdAsc()).orderByIdAsc().gets());
    return { first: rows.values().map(m => [m.getId(), m.getFirstTask()]), unlimited };
  },
  // varchar with varchar meet; i32 with varchar do not and are OPERATOR_NOT_ALLOWED (DIA-170).
  column_pairs: async s => {
    const p = new People();
    const meet = await new Tasks().connect(s.db).joinOwnerWithId(p).titleNeName(p).getCount();
    const q = new People();
    return { meet, refused: await codeOf(new Tasks().connect(s.db).joinOwnerWithId(q).pointsEqName(q).getCount()) };
  },
  // Lk: A-Z and a-z without regard to case, % literal (DIA-171).
  contains: async s => ({
    fold: (await new People().connect(s.db).removeAllColumns().lkName('ANN').orderByIdAsc().gets()).toArray(),
    literal: (await new People().connect(s.db).removeAllColumns().lkName('%').orderByIdAsc().gets()).toArray(),
  }),
  // Lb: compared by code point (DIA-172).
  contains_binary: async s => ({
    exact: (await new People().connect(s.db).removeAllColumns().lbName('Ann').orderByIdAsc().gets()).toArray(),
    folded: (await new People().connect(s.db).removeAllColumns().lbName('ann').orderByIdAsc().gets()).toArray(),
  }),
  // The default now of joined, a datetime(0), holds no fraction, and a relative time function past 9999-12-31 is NULL and
  // matches no row (DIA-173).
  now_truncated: async s => {
    const joined = (await new People().connect(s.db).id('P1').get()).getJoined();
    const far = orm.secondsLater(1000000000000000);
    return {
      fraction: Number(joined.split('.')[1] ?? '0'),
      out_of_range: [await new People().connect(s.db).andGtJoined(far).getCount(), await new People().connect(s.db).andLeJoined(far).getCount()],
    };
  },
  // A read through the column of the index ix_tasks_owner, which the corpus derives in memory (DIA-176).
  index_read: async s => (await new Tasks().connect(s.db).removeAllColumns().owner('P2').gets()).toArray(),
  // An index hint, which the corpus does not name: CAPABILITY_UNSUPPORTED (DIA-186).
  force_index: async s => new Tasks().connect(s.db).forceIndexIxTasksOwner().owner('P1').gets(),
  // A heading of another table in tasks.flowmark.md is format.block: a read of tasks fails CONSTRAINT naming the file,
  // and reads again once the file is restored (DIA-190).
  unavailable_table: async s => {
    const file = path.join(s.dir, 'tasks.flowmark.md');
    const text = await readFile(file);
    await writeFile(file, Buffer.concat([text, Buffer.from('\n## people row P1\n')]));
    let broken = null;
    let namesFile = false;
    try {
      await new Tasks().connect(s.db).getCount();
    } catch (error) {
      if (!(error instanceof OrmError)) throw error;
      broken = error.code;
      namesFile = error.message.includes('tasks.flowmark.md');
    }
    await writeFile(file, text);
    return { broken, names_file: namesFile, restored: await new Tasks().connect(s.db).getCount() };
  },
  // A catalog with an aes column is a schema error on a corpus (DIA-178).
  install_refuses_aes: async s => refusedInstall(s, 'aes'),
  // A catalog with an audit setting is a schema error on a corpus (DIA-179).
  install_refuses_audit: async s => refusedInstall(s, 'audit'),
};

/** The result, written as JSON and read back: it has the same form as expect in cases.json. The TypeScript model holds dates as the YYYY-MM-DD text that README
 * "Results" defines. */
export function normalize(value) {
  if (value instanceof StyledValue) throw new Error('a case result holds a styled value, which has no JSON form here');
  return JSON.parse(JSON.stringify(value ?? null));
}
