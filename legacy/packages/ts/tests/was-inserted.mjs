// INT-53 backendWaitingForLock with a waiter on PostgreSQL; the recipe utils holds the rest. The model is the clock
// fixture contracts/fixtures/clock.dbs. Each case runs on a case database of its own (case-database.mjs); the test fails
// when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.
//
// Usage: node --test packages/ts/tests/was-inserted.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { models } from './registered_models.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CORE, Db } from '../dist/index.js';
import { caseTest } from '../../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { schemaOf } from './schema_of.mjs';

const clockText = await readFile(new URL('../../../contracts/fixtures/clock.dbs', import.meta.url), 'utf8');

const { clock_event: ClockEvent } = models(clockText);

/** Connects to a case database of driver, installs the clock fixture on it and runs body with the connection and its DSN. */
async function onCase(driver, body) {
  await withCaseDatabase(driver, () => {}, async database => {
    const db = await Db.connect(database.dsn);
    try {
      await db.utils().schema().install(schemaOf(clockText));
      await body(db, database.dsn);
    } finally {
      await db.close();
    }
  });
}

/** Inserts one clock event with label in the active transaction and returns its identity key. */
async function insertEvent(db, label) {
  const row = new ClockEvent().connect(db);
  row[CORE].setValue('label', label);
  const created = await row.create();
  return Number(created[CORE].column('seq'));
}

/**
 * PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row; a child process
 * updates the same row and blocks. The parent checks the state the database reports, bounded to ten seconds, before it
 * commits and lets the child finish.
 */
// Requirements: INT-53.
caseTest('backend-waiting-for-lock/postgres-waiter', async () => {
  await onCase('postgres', async (db, dsn) => {
    let seq = 0;
    await db.transaction(async () => { seq = await insertEvent(db, 'held'); }, { retry: 0 });
    let child;
    let output = '';
    await db.transaction(async () => {
      const held = new ClockEvent().connect(db);
      held[CORE].setValue('seq', seq);
      held[CORE].setValue('label', 'parent');
      await held.update();
      child = spawn(process.execPath, [new URL('./was-inserted-child.mjs', import.meta.url).pathname, dsn, String(seq)], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.on('data', chunk => { output += chunk; });
      let waiting = false;
      for (let deadline = Date.now() + 10_000; !waiting && Date.now() < deadline; await new Promise(done => setTimeout(done, 20))) {
        waiting = await db.utils().backendWaitingForLock();
      }
      assert.equal(waiting, true, 'the child backend waits for the row lock the transaction holds');
    }, { retry: 0 });
    const code = await new Promise(done => child.on('close', done));
    assert.equal(code, 0, 'the waiting child exits without error');
    assert.equal(output, 'done\n');
  });
});
