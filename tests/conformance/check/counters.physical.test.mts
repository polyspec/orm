// The physical cases of the counters and the state check on the bench databases of TEST_ENV (make conformance-counter-check):
// a row and a counter that a test advances are observed and restored, a failed runner that left a row behind reports both
// failures, and PostgreSQL sequences are restored by the table that owns them.
import assert from 'node:assert/strict';
import { DATABASE, caseTest } from '../../testcase.mts';
import { benchDatabases, benchDsn, lockBench } from './bench.mts';
import { conformanceWriteTables, quoteIdentifier, readCounters, restoreCounters } from './counters.mts';
import { openStateDatabase, text, type StateDatabase } from './database.mts';
import { errorIncludes, runAndCheckState, stateDeadline } from './main.mts';
import { snapshotDatabase } from './state.mts';

lockBench();

// insertTask inserts a task row and returns its seq.
async function insertTask(db: StateDatabase, driver: string, title: string): Promise<bigint> {
  if (driver === 'postgres') return BigInt(text((await db.query(`INSERT INTO task (title, state) VALUES ('${title}', 'open') RETURNING seq`)).rows[0]?.[0]));
  const { lastInsertId } = await db.exec(`INSERT INTO task (title, state) VALUES ('${title}', 'open')`);
  if (lastInsertId === null) throw new Error('the insert reported no id');
  return lastInsertId;
}

for (const { driver, env } of benchDatabases) {
  // database 하나에서 state digest를 앞뒤로 읽고 counter를 읽고 되돌린다.
  caseTest(`TestPhysicalCounterCleanup/${driver}`, 3 * stateDeadline, async () => {
    const db = await openStateDatabase(driver, benchDsn(env));
    try {
      const before = await snapshotDatabase(db, driver);
      const counters = await readCounters(db, driver);
      let restored = false;
      let id: bigint | null = null;
      try {
        const counterName = driver === 'postgres' ? '"public"."task_seq_seq"' : 'task';
        if (!counters.has(counterName)) {
          assert.equal(driver, 'sqlite', `task counter ${counterName} is not observable`);
          const definition = text((await db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task'")).rows[0]?.[0]);
          assert.match(definition.toUpperCase(), /AUTOINCREMENT/, 'task has no observable SQLite auto-increment counter');
        }
        id = await insertTask(db, driver, 'counter-check');
        assert.notEqual(await snapshotDatabase(db, driver), before, 'inserted row was not observed');
        const advanced = await readCounters(db, driver);
        assert.notDeepEqual(advanced.get(counterName), counters.get(counterName),
          `${driver} task counter did not advance after insert: before=${JSON.stringify(String(counters.get(counterName)?.value))} after=${JSON.stringify(String(advanced.get(counterName)?.value))}`);
        await db.exec(`DELETE FROM task WHERE seq = ${id}`);
        id = null;
        await restoreCounters(db, driver, counters);
        restored = true;
        assert.equal(await snapshotDatabase(db, driver), before, 'persistent rows or counters changed after cleanup');
      } finally {
        if (id !== null) await db.exec(`DELETE FROM task WHERE seq = ${id}`);
        if (!restored) await restoreCounters(db, driver, counters);
      }
    } finally {
      await db.close();
    }
  });
}

for (const { driver, env } of benchDatabases) {
  // database 하나에서 state digest를 앞뒤로 읽고 counter를 읽고 되돌린다.
  caseTest(`TestPhysicalFailedRunnerStateCheck/${driver}`, 3 * stateDeadline, async () => {
    const db = await openStateDatabase(driver, benchDsn(env));
    try {
      const before = await snapshotDatabase(db, driver);
      const counters = await readCounters(db, driver);
      let id: bigint | null = null;
      try {
        const runnerError = new Error('runner failed');
        await assert.rejects(runAndCheckState(db, driver, 'rust', 'first', async () => {
          id = await insertTask(db, driver, 'failed-run-check');
          throw runnerError;
        }), (error: unknown) => errorIncludes(error, runnerError) && error instanceof Error && error.message.includes(`changed ${driver} database state`),
        'runner failure and remaining row must both be reported');
      } finally {
        if (id !== null) await db.exec(`DELETE FROM task WHERE seq = ${id}`);
        await restoreCounters(db, driver, counters);
        assert.equal(await snapshotDatabase(db, driver), before, 'failed-run test did not restore all rows and counters');
      }
    } finally {
      await db.close();
    }
  });
}

// TestPhysicalPostgresCounterOwner restores PostgreSQL sequences by the table that owns them. A table name long enough
// that PostgreSQL truncates the name of its serial sequence (63 bytes) still restores, and a changed sequence that no
// table owns, or that an undeclared table owns, is refused. The case runs in a case database of its own on
// ORM_TEST_POSTGRES_DSN, dropped at its end.
caseTest('TestPhysicalPostgresCounterOwner', DATABASE, async ({ step }) => {
  const base = benchDsn('ORM_TEST_POSTGRES_DSN');
  const name = `orm_case_${process.pid}_1`;
  const admin = await openStateDatabase('postgres', base);
  const long = `conformance_counter_owner_${'x'.repeat(63 - 'conformance_counter_owner_'.length)}`;
  try {
    await admin.exec(`CREATE DATABASE ${name}`);
    step(`database ${name} created`);
    const url = new URL(base);
    url.pathname = `/${name}`;
    const db = await openStateDatabase('postgres', url.href);
    conformanceWriteTables.add(long);
    try {
      for (const statement of [
        `CREATE TABLE ${quoteIdentifier(long)} (seq bigserial PRIMARY KEY, label text)`,
        'CREATE TABLE task (seq bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, label text)',
        'CREATE TABLE undeclared (seq bigserial PRIMARY KEY, label text)',
        'CREATE SEQUENCE task_seq_seq_free',
      ]) await db.exec(statement);
      const sequence = text((await db.query("SELECT pg_get_serial_sequence($1, 'seq')", [quoteIdentifier(long)])).rows[0]?.[0]);
      assert.ok(!sequence.includes(long), `the sequence ${sequence} keeps the whole table name; the case needs a truncated one`);
      step(`table ${long} owns sequence ${sequence}`);
      const before = await readCounters(db, 'postgres');
      const insert = (table: string) => db.exec(`INSERT INTO ${quoteIdentifier(table)} (label) VALUES ('a'), ('b')`);
      await insert(long);
      await insert('task');
      await restoreCounters(db, 'postgres', before);
      const after = await readCounters(db, 'postgres');
      for (const [counter, value] of before) assert.deepEqual(after.get(counter), value, `counter ${counter} after the restore`);
      await insert('undeclared');
      await assert.rejects(restoreCounters(db, 'postgres', before), /undeclared postgres counter changed/, 'a sequence of an undeclared table');
      await db.exec("SELECT setval('undeclared_seq_seq', 1, false)");
      await db.exec("SELECT nextval('task_seq_seq_free')");
      await assert.rejects(restoreCounters(db, 'postgres', before), /owned by no table/, 'a sequence that no table owns');
    } finally {
      conformanceWriteTables.delete(long);
      await db.close();
    }
  } finally {
    try {
      await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      step(`database ${name} dropped`);
    } finally {
      await admin.close();
    }
  }
});
