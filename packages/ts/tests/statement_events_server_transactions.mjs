// Runs each entry of the server_transactions of tests/events/vectors.json with the TypeScript client on a case
// database of its database (statement-events-run.mjs, case-database.mjs), as a case named by the database.
//
// Usage: node packages/ts/tests/statement_events_server_transactions.mjs (after npm run typescript:build)
import assert from 'node:assert/strict';
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runServerTransactions, vectors } from './statement-events-run.mjs';

for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
}
for (const spec of vectors.server_transactions) {
  // Requirements: INT-149.
  caseTest(`server-transactions/${spec.database}`, DATABASE, async ({ step }) => {
    const failures = [];
    const check = (cond, message) => { if (!cond) failures.push(`server_transactions/${spec.database}: ${message}`); };
    await withCaseDatabase(spec.database, step, database => runServerTransactions(spec, database.dsn, check));
    if (failures.length > 0) throw new Error(failures.join('\n'));
  });
}

// Requirements: INT-149. Every database of the statement events is named once: by an entry, or by an excluded database with its
// reason. SQLite has no server transaction (CR16-2), so it is excluded, and no entry names it.
caseTest('server-transactions/databases-named-once', 15000, () => {
  const named = vectors.server_transactions.map(spec => spec.database);
  const excluded = vectors.server_transactions_excluded ?? {};
  assert.equal(new Set(named).size, named.length, 'an entry names a database twice');
  assert.deepEqual([...new Set([...named, ...Object.keys(excluded)])].sort(), ['mysql', 'postgres', 'sqlite']);
  assert.deepEqual(named.filter(database => database in excluded), [], 'a database is both an entry and excluded');
  for (const [database, exclusion] of Object.entries(excluded)) {
    assert.ok(String(exclusion.reason ?? '').trim(), `the exclusion of ${database} states no reason`);
  }
});
