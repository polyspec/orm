// The session state of a transaction ends with the transaction (docs/spec/config.md CFG-30), on SQLite, MySQL and
// PostgreSQL. A transaction on a connection with one pooled connection takes the named lock of utils().lock, sets a
// local value with utils().setLocal and commits. After it the same server session holds no value: PostgreSQL has no
// setting ormtest.session and MySQL no user variable orm.ormtest.session, which a statement on that one connection reads,
// and another connection takes the same lock. SQLite has no session setting, so it checks the lock alone. Each case runs on a case database of its own (case-database.mjs);
// the test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.
// Requirements: CFG-30.
//
// Usage: node packages/ts/tests/session_state.mjs (after npm run typescript:build)
import { Db } from '../dist/index.js';
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { createFailureCheck } from './check-state.mjs';

let failures = 0;
let current = '';
const check = createFailureCheck(() => current, () => { failures++; });

/** The transaction-scoped lock and local value of a committed transaction are gone in the next transaction. */
async function sessionStateEndsWithTransaction(dsn) {
  const key = `orm_test.session.${process.pid}`;
  const db = await Db.connect(dsn, { poolSize: 1 });
  const other = await Db.connect(dsn);
  try {
    await db.transaction(async () => {
      await db.utils().lock(key);
      await db.utils().setLocal('ormtest.session', 'kept');
      check(await db.utils().local('ormtest.session') === 'kept', 'the transaction reads its local value');
    }, { retry: 0 });
    const driver = new URL(dsn).protocol.slice(0, -1);
    const leftover = { postgres: "SELECT current_setting('ormtest.session', true)", mysql: 'SELECT @`orm.ormtest.session`' }[driver];
    if (leftover !== undefined) {
      const [[value]] = await db.utils().read('utility', [], leftover);
      check(value === null || value === '', `the session keeps the local value of the committed transaction: ${JSON.stringify(value)}`);
    }
    await other.transaction(async () => { await other.utils().lock(key); }, { retry: 0 });
  } finally {
    await other.close();
    await db.close();
  }
}

for (const driver of ['sqlite', 'mysql', 'postgres']) {
  caseTest(`session-state/ends-with-transaction/${driver}`, DATABASE, async ({ step }) => {
    const before = failures;
    current = driver;
    await withCaseDatabase(driver, step, database => sessionStateEndsWithTransaction(database.dsn));
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
}
