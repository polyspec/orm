// INT-52 wasInserted and INT-53 backendWaitingForLock on Utils, on SQLite, MySQL and PostgreSQL. The model is the clock
// fixture contracts/fixtures/clock.dbs. Each case runs on a case database of its own (case-database.mjs); the test fails
// when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.
//
// Usage: node --test packages/ts/tests/was-inserted.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { models } from './registered_models.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CORE, Db, dbspecManifest, parseDbspec } from '../dist/index.js';
import { caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';

const clockText = await readFile(new URL('../../../contracts/fixtures/clock.dbs', import.meta.url), 'utf8');
const CASE_DEADLINE_MS = 30_000;

/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

const { clock_event: ClockEvent } = models(clockText);

/** The error code that call throws, or 'none'. */
async function codeOf(call) {
  try {
    await call();
  } catch (error) {
    return error.code;
  }
  return 'none';
}

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

const drivers = ['sqlite', 'mysql', 'postgres'];

/** Inserts one clock event with label in the active transaction and returns its identity key. */
async function insertEvent(db, label) {
  const row = new ClockEvent().connect(db);
  row[CORE].setValue('label', label);
  const created = await row.create();
  return Number(created[CORE].column('seq'));
}

/** A generated insert inside a transaction is recorded for its key; a key never inserted is not; a nested rollback removes its key only. */
for (const driver of drivers) {
  caseTest(`was-inserted/tracks-generated-rows/${driver}`, CASE_DEADLINE_MS, async () => {
    await onCase(driver, async db => {
      const utils = db.utils();
      let outer = 0;
      let nested = 0;
      await db.transaction(async () => {
        outer = await insertEvent(db, 'outer');
        assert.equal(utils.wasInserted('clock_event', outer), true, 'the outer insert is recorded');
        assert.equal(utils.wasInserted('clock_event', outer + 1000), false, 'a key that was never inserted is not recorded');
        await assert.rejects(db.transaction(async () => {
          nested = await insertEvent(db, 'nested');
          assert.equal(utils.wasInserted('clock_event', nested), true, 'the nested insert is recorded');
          throw new Error('roll back the nested savepoint');
        }, { retry: 0 }));
        assert.equal(utils.wasInserted('clock_event', nested), false, 'a rolled back insert leaves the write set');
        assert.equal(utils.wasInserted('clock_event', outer), true, 'the outer insert survives a nested rollback');
      }, { retry: 0 });
    });
  });

  /** The utility needs an active transaction and a valid entity and key; each violation is CONFIG. */
  caseTest(`was-inserted/needs-a-transaction-and-valid-arguments/${driver}`, CASE_DEADLINE_MS, async () => {
    await onCase(driver, async db => {
      const utils = db.utils();
      assert.equal(await codeOf(async () => utils.wasInserted('clock_event', 1)), 'CONFIG', 'outside a transaction');
      await db.transaction(async () => {
        assert.equal(await codeOf(async () => utils.wasInserted('', 1)), 'CONFIG', 'an empty entity');
        assert.equal(await codeOf(async () => utils.wasInserted('clock_event', 0)), 'CONFIG', 'a zero key');
        assert.equal(await codeOf(async () => utils.wasInserted('clock_event', -1)), 'CONFIG', 'a negative key');
      }, { retry: 0 });
    });
  });

  /** SQLite and MySQL have no backend lock view: INT-53 answers false without a statement, and PostgreSQL with no waiter answers false. */
  caseTest(`backend-waiting-for-lock/no-waiter/${driver}`, CASE_DEADLINE_MS, async () => {
    await onCase(driver, async db => {
      assert.equal(await db.utils().backendWaitingForLock(), false, 'no backend waits for a lock');
    });
  });
}

/**
 * PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row; a child process
 * updates the same row and blocks. The parent checks the state the database reports, bounded to ten seconds, before it
 * commits and lets the child finish.
 */
caseTest('backend-waiting-for-lock/postgres-waiter', CASE_DEADLINE_MS, async () => {
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
