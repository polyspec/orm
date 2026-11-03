// The rollback fault of the test entry point, on SQLite, MySQL and PostgreSQL, with the fixture
// contracts/fixtures/rollback.dbs. The failed rollbacks of CFG-15 and INT-155 are cases of
// contracts/fixtures/transactions/transactions.json.
//
// The rollback_fault case sets a rollback fault in the test entry point that resolves only under condition `orm-test`
// of `@polyspec/orm/testing`.
//
// Usage: node --conditions=orm-test packages/ts/tests/rollback.mjs [case ...] (after npm run typescript:build)
import * as packageEntry from '../dist/index.js';
import { withCaseDatabase } from './case-database.mjs';
import { registerDatabaseCases } from './database-case-tests.mjs';
import { CORE, Db, OrmError } from '../dist/index.js';
import { failNextRollback } from '@polyspec/orm/testing';
import { schemaOf } from './schema_of.mjs';
import { loadDatabaseCaseFixture } from './database-case-fixture.mjs';
import { checkConditionalEntry } from './conditional-entry.mjs';

const { text: rollbackText, model: RollbackProbe, deadline: CASE_DEADLINE_MS, state, check, raised } =
  await loadDatabaseCaseFixture('rollback.dbs', 'rollback_probe');
const probe = (db, label) => { const m = new RollbackProbe().connect(db); m[CORE].setValue('label', label); return m; };

/** Opens the client and installs the fixture. */
async function connect(driver, dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install(schemaOf(rollbackText));
  return db;
}

/** Checks a ROLLBACK error: both errors are kept and the message names both. */
function checkRollback(error, subject) {
  check(error instanceof OrmError, `${subject} raises ${error}`);
  check(error?.code === 'ROLLBACK', `${subject} code ${error?.code}: ${error?.message}`);
  check(error?.cause !== undefined, `${subject} keeps the callback error`);
  check(error?.rollback !== undefined, `${subject} keeps the rollback error`);
  if (error?.cause !== undefined && error?.rollback !== undefined) {
    const want = `ROLLBACK: transaction failed (${error.cause.message}) and rollback failed (${error.rollback.message})`;
    check(error.message === want, `${subject} message ${JSON.stringify(error.message)}, want ${JSON.stringify(want)}`);
  }
}

/**
 * The test entry point resolves only under condition `orm-test`, and the package entry point
 * does not export the fault.
 */
function checkFaultEntry() {
  const packageRoot = new URL('..', import.meta.url).pathname;
  const { withoutCondition: plain, withCondition: tested } = checkConditionalEntry('@polyspec/orm/testing', 'orm-test', packageRoot);
  check(plain.status !== 0 && plain.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'), `the test entry point resolves without the condition orm-test: status ${plain.status} ${plain.stderr}`);
  check(tested.status === 0, `the test entry point does not resolve under the condition orm-test: ${tested.stderr}`);
  check(!('failNextRollback' in packageEntry) && !('armRollbackFault' in packageEntry), 'the package entry point exports the rollback fault');
}

/**
 * The rollback fault of the test entry point. A committed transaction leaves the fault in place,
 * and the next transaction whose callback fails is rolled back, and that rollback reports FAULT
 * and the transaction throws a ROLLBACK that carries both the callback error and the fault. The fault
 * is consumed: after that, the transaction throws only the callback error, and the connection
 * handles later requests.
 */
// Requirements: INT-72.
async function rollbackFault(driver, dsn) {
  checkFaultEntry();
  const db = await connect(driver, dsn);
  try {
    failNextRollback(db);
    const committed = await raised(() => db.transaction(async () => { await probe(db, 'committed').create(); }, { retry: 0 }));
    check(committed === undefined, `a committed transaction with an armed fault raises ${committed}`);
    const callback = new Error('rollback fault callback failed');
    const failing = async () => { await probe(db, 'rolled back').create(); throw callback; };
    const error = await raised(() => db.transaction(failing, { retry: 0 }));
    checkRollback(error, 'transaction');
    check(error?.cause === callback, 'the ROLLBACK error keeps the callback error itself');
    check(error?.rollback instanceof OrmError && error.rollback.code === 'FAULT', `the rollback error is FAULT: ${error?.rollback}`);
    check(await new RollbackProbe().connect(db).getCount() === 1, 'the faulted rollback keeps only the committed row');
    const again = await raised(() => db.transaction(failing, { retry: 0 }));
    check(again === callback, `the transaction after the consumed fault raises the callback error: ${again}`);
    check(await new RollbackProbe().connect(db).getCount() === 1, 'the second rollback keeps only the committed row');
  } finally { await db.close(); }
}

// Requirements: INT-72.
const cases = { rollback_fault: rollbackFault };
registerDatabaseCases({
  feature: 'rollback', cases, deadline: CASE_DEADLINE_MS, withDatabase: withCaseDatabase,
  getFailures: () => state.failures, setCurrent: value => { state.current = value; },
  runCase: (run, _name, driver, database) => run(driver, database.dsn),
});
if (state.failures > 0) process.exitCode = 1;
