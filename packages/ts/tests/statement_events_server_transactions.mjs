// Runs each entry of the server_transactions of tests/events/vectors.json with the TypeScript client on a case
// database of its database (statement-events-run.mjs, case-database.mjs), as a case named by the database.
//
// Usage: node packages/ts/tests/statement_events_server_transactions.mjs (after npm run typescript:build)
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
