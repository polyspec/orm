// Driver errors that the error catalog does not list, and CHECK violations,
// on SQLite, MySQL and PostgreSQL, with the fixture
// contracts/fixtures/refusal.dbs. refused_row is immutable, so its triggers
// refuse every update with a database error that the catalog does not list;
// the client reports it as an OrmError with the code DRIVER, the driver
// message, and the driver error as its cause. Its CHECK constraint refuses a
// nonpositive amount with CONSTRAINT. Each case runs on a case database of
// its own on the servers of ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, or a
// new SQLite file (case-database.mjs); the test fails when either DSN is unset.
//
// Usage: node packages/ts/tests/driver-error.mjs [case ...] (after npm run typescript:build)
import { CORE, Db, OrmError } from '../dist/index.js';
import { withCaseDatabase } from './case-database.mjs';
import { registerDatabaseCases } from './database-case-tests.mjs';
import { schemaOf } from './schema_of.mjs';
import { loadDatabaseCaseFixture } from './database-case-fixture.mjs';

const { text: refusalText, model: RefusedRow, deadline: CASE_DEADLINE_MS, state, check, raised } =
  await loadDatabaseCaseFixture('refusal.dbs', 'refused_row');
const row = (db, amount) => { const m = new RefusedRow().connect(db); m[CORE].setValue('amount', amount); return m; };

async function connect(dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install(schemaOf(refusalText));
  return db;
}

/** An update that the immutable trigger refuses fails with DRIVER and keeps the driver error. */
async function triggerRefused(dsn) {
  const db = await connect(dsn);
  try {
    const created = await row(db, 1).create();
    const seq = created[CORE].column('seq');
    const error = await raised(() => { created[CORE].setValue('amount', 2); return created.update(); });
    check(error instanceof OrmError, `refused update raises ${error}`);
    check(error?.code === 'DRIVER', `refused update code ${error?.code}`);
    check(String(error?.message).includes('table refused_row is immutable'), `refused update message ${error?.message}`);
    check(error?.cause !== undefined && !(error.cause instanceof OrmError), 'refused update keeps the driver error');
    const stored = await new RefusedRow().connect(db).seq(seq).addAllColumns().get();
    check(stored?.[CORE].column('amount') === 1, 'refused update keeps the row');
  } finally { await db.close(); }
}

/** An insert that the CHECK constraint refuses fails with CONSTRAINT. */
async function checkRefused(dsn) {
  const db = await connect(dsn);
  try {
    const error = await raised(() => row(db, 0).create());
    check(error instanceof OrmError, `refused insert raises ${error}`);
    check(error?.code === 'CONSTRAINT', `refused insert code ${error?.code}`);
    check(String(error?.message).includes('amount_positive'), `refused insert message ${error?.message}`);
    check(error?.cause !== undefined && !(error.cause instanceof OrmError), 'refused insert keeps the driver error');
    check(await new RefusedRow().connect(db).getCount() === 0, 'refused insert writes no row');
  } finally { await db.close(); }
}

const cases = { trigger_refused: triggerRefused, check_refused: checkRefused };
registerDatabaseCases({
  feature: 'driver-error', cases, deadline: CASE_DEADLINE_MS, withDatabase: withCaseDatabase,
  getFailures: () => state.failures, setCurrent: value => { state.current = value; },
  runCase: (run, _name, _driver, database) => run(database.dsn),
});
if (state.failures > 0) process.exitCode = 1;
