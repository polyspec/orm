// statement_events coverage: on the database that feature-check chose (ORM_FEATURE_DATABASE),
// every case of tests/events/vectors.json runs in a new case database (case-database.mjs), and each
// event is compared with the expected event. The bench database is not read or written. The output is only the lines of the passing cases.
// When run without a case ID (the parity check's node --test), a test with that ID is registered for each case of vectors.json,
// and each runs that case in a new case database on MySQL, PostgreSQL, and SQLite.
import { DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runCases } from './coverage_case.mjs';
import { runEventCase, vectors } from './statement-events-run.mjs';

/** Runs case c on a new case database of each dialect and fails with every check that failed. */
async function runOn(c, dialects) {
  const failures = [];
  for (const driver of dialects) {
    const check = (cond, message) => { if (!cond) failures.push(`${c.id}/${driver}: ${message}`); };
    await withCaseDatabase(driver, () => {}, database => runEventCase(c, driver, database.dsn, check));
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

await runCases('coverage_statement_events.mjs', {
  async statement_events({ driver }) {
    const failures = [];
    for (const c of vectors.cases) {
      try { await runOn(c, [driver]); } catch (error) { failures.push(error.message); }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  },
}, DATABASE, Object.fromEntries(vectors.cases.map(c => [c.id, () => runOn(c, ['mysql', 'postgres', 'sqlite'])])));
