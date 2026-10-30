// Runs each vector case from tests/events/vectors.json with the TypeScript client on MySQL, PostgreSQL, and SQLite
// (statement-events-run.mjs). Each case uses a new case database (case-database.mjs). The server_transactions entries
// run in statement_events_server_transactions.mjs.
//
// Usage: node packages/ts/tests/statement-events.mjs [--dialect mysql|postgres|sqlite]... [case ...]
// (after npm run typescript:build)
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runEventCase, vectors } from './statement-events-run.mjs';

const args = process.argv.slice(2);
const dialects = [];
const selected = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dialect') dialects.push(args[++i]);
  else selected.push(args[i]);
}
const cases = vectors.cases.filter(c => selected.length === 0 || selected.includes(c.id));
for (const id of selected) if (!vectors.cases.some(c => c.id === id)) throw new Error(`unknown case ${id}`);
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
}
const selectedDialects = dialects.length > 0 ? dialects : ['mysql', 'postgres', 'sqlite'];
for (const c of cases) {
  // Requirements: INT-77, INT-91, INT-96, PLN-44. Every case subscribes a recording subscriber and checks the statement-event fields of the SQL output; subscriber_error checks the subscriber failure.
  caseTest(c.id, DATABASE * selectedDialects.length, async ({ step }) => {
    const failures = [];
    for (const dialect of selectedDialects) {
      const check = (cond, message) => { if (!cond) failures.push(`${c.id}/${dialect}: ${message}`); };
      await withCaseDatabase(dialect, step, database => runEventCase(c, dialect, database.dsn, check));
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  });
}
