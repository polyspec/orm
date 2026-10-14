// The state digest and the counters on SQLite files (state.mts, counters.mts): rows and sequences change the digest, a
// database without sqlite_sequence has no counters, a declared sequence is restored, and the row lock table of the SQLite
// client is not state.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE, caseTest, withTemporaryDirectory } from '../../testcase.mts';
import { readCounters, restoreCounters } from './counters.mts';
import { sqliteDatabase } from './database.mts';
import { snapshotDatabase } from './state.mts';

// open is a SQLite database in a new temporary directory.
const open = (directory: string, name: string): { sqlite: DatabaseSync; db: ReturnType<typeof sqliteDatabase> } => {
  const sqlite = new DatabaseSync(join(directory, name));
  return { sqlite, db: sqliteDatabase(sqlite) };
};

caseTest('TestSnapshotIncludesRowsAndSequenceState', DATABASE, () => withTemporaryDirectory('orm-state-test-', async temp => {
  const { sqlite, db } = open(temp, 'state.sqlite');
  try {
    sqlite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)');
    const before = await snapshotDatabase(db, 'sqlite');
    sqlite.exec("INSERT INTO items (value) VALUES ('first')");
    assert.notEqual(await snapshotDatabase(db, 'sqlite'), before, 'inserted row did not change snapshot');
    sqlite.exec('DELETE FROM items');
    assert.notEqual(await snapshotDatabase(db, 'sqlite'), before, 'advanced sequence was hidden after row deletion');
  } finally {
    await db.close();
  }
}));

caseTest('TestSQLiteStateWithoutAutoIncrement', DATABASE, () => withTemporaryDirectory('orm-state-test-', async temp => {
  const { sqlite, db } = open(temp, 'plain.sqlite');
  sqlite.exec('CREATE TABLE state (value INTEGER NOT NULL)');
  const tables = sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
  assert.equal(tables?.count, 0, 'fixture unexpectedly created sqlite_sequence');
  assert.equal((await readCounters(db, 'sqlite')).size, 0, 'ordinary SQLite table has counters');
  const before = await snapshotDatabase(db, 'sqlite');
  sqlite.exec('INSERT INTO state (value) VALUES (7)');
  assert.notEqual(await snapshotDatabase(db, 'sqlite'), before, 'row change disappeared when sqlite_sequence was absent');
  await db.close();
  await assert.rejects(readCounters(db, 'sqlite'), 'an unrelated counter query error was accepted as an absent sequence');
}));

caseTest('TestRestoreDeclaredSequenceAfterWrite', DATABASE, () => withTemporaryDirectory('orm-state-test-', async temp => {
  const { sqlite, db } = open(temp, 'restore.sqlite');
  try {
    sqlite.exec('CREATE TABLE author (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
    const before = await snapshotDatabase(db, 'sqlite');
    const counters = await readCounters(db, 'sqlite');
    sqlite.exec("INSERT INTO author (name) VALUES ('temp')");
    sqlite.exec('DELETE FROM author');
    await restoreCounters(db, 'sqlite', counters);
    assert.equal(await snapshotDatabase(db, 'sqlite'), before, 'database state changed after declared sequence cleanup');
  } finally {
    await db.close();
  }
}));

// TestSnapshotIgnoresTheRowLockTable는 SQLite client가 첫 transaction 전에 만드는 orm__row_lock과 그 행이 상태를
// 바꾸지 않는지 확인한다. 그 table이 생겨도 test가 database에 남긴 것은 없다.
caseTest('TestSnapshotIgnoresTheRowLockTable', DATABASE, () => withTemporaryDirectory('orm-state-test-', async temp => {
  const { sqlite, db } = open(temp, 'lock.sqlite');
  try {
    sqlite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
    const before = await snapshotDatabase(db, 'sqlite');
    sqlite.exec('CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))');
    sqlite.exec('INSERT INTO "orm__row_lock" ("id") VALUES (1)');
    assert.equal(await snapshotDatabase(db, 'sqlite'), before, 'the row lock table of the client changed the snapshot');
  } finally {
    await db.close();
  }
}));
