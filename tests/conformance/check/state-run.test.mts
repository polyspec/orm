// The state check around a runner (main.mts runAndCheckState) on SQLite files: a failed runner that left a row behind
// reports both failures, and one that rolled back reports only its own error.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE, caseTest } from '../../testcase.mts';
import { sqliteDatabase } from './database.mts';
import { errorIncludes, runAndCheckState } from './main.mts';

const bench = (): { sqlite: DatabaseSync; db: ReturnType<typeof sqliteDatabase> } => {
  const sqlite = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'orm-state-run-test-')), 'bench.db'));
  sqlite.exec('CREATE TABLE author (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  return { sqlite, db: sqliteDatabase(sqlite) };
};

caseTest('TestFailedRunStillChecksRemainingDatabaseState', DATABASE, async () => {
  const { sqlite, db } = bench();
  try {
    await assert.rejects(runAndCheckState(db, 'sqlite', 'rust', 'first', async () => {
      sqlite.exec("INSERT INTO author(name) VALUES ('leftover')");
      throw new Error('runner failed');
    }), (error: unknown) => error instanceof Error && error.message.includes('runner failed') && error.message.includes('changed sqlite database state'),
    'runner and state failures must both be reported');
  } finally {
    await db.close();
  }
});

caseTest('TestFailedRunReportsOriginalErrorAfterRollback', DATABASE, async () => {
  const { sqlite, db } = bench();
  const runnerError = new Error('runner failed');
  try {
    await assert.rejects(runAndCheckState(db, 'sqlite', 'rust', 'first', async () => {
      sqlite.exec('BEGIN');
      try {
        sqlite.exec("INSERT INTO author(name) VALUES ('rolled back')");
      } finally {
        sqlite.exec('ROLLBACK');
      }
      throw runnerError;
    }), (error: unknown) => errorIncludes(error, runnerError) && error instanceof Error && !error.message.includes('changed sqlite database state'),
    'rolled-back failure must retain only the runner error');
  } finally {
    await db.close();
  }
});
