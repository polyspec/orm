// Runs the statement event cases of tests/events/vectors.json with the TypeScript client on MySQL, PostgreSQL,
// and SQLite (statement-events-run.mjs). Each case uses a new case database (case-database.mjs).
// The server_transactions of the vector runs on PostgreSQL as the case with id server_transactions.
//
// Usage: node packages/ts/tests/statement-events.mjs [--dialect mysql|postgres|sqlite]... [case ...]
// (after npm run typescript:build)
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runEventCase, runServerTransactions, vectors } from './statement-events-run.mjs';

const args = process.argv.slice(2);
const dialects = [];
const selected = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dialect') dialects.push(args[++i]);
  else selected.push(args[i]);
}
const cases = vectors.cases.filter(c => selected.length === 0 || selected.includes(c.id));
for (const id of selected) if (id !== 'server_transactions' && !vectors.cases.some(c => c.id === id)) throw new Error(`unknown case ${id}`);
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
}
let failures = 0;
for (const dialect of dialects.length > 0 ? dialects : ['mysql', 'postgres', 'sqlite']) {
  for (const c of cases) {
    const name = `statement_events/${c.id}/${dialect}`;
    let failed = 0;
    const check = (cond, message) => { if (!cond) { failed++; console.error(`FAIL ${name}: ${message}`); } };
    caseTest(name, DATABASE, async ({ step }) => {
      await withCaseDatabase(dialect, step, database => runEventCase(c, dialect, database.dsn, check));
      if (failed > 0) throw new Error(`${failed} check(s) failed; each FAIL line above names one`);
    });
  }
}
const spec = vectors.server_transactions;
if ((selected.length === 0 || selected.includes('server_transactions')) && (dialects.length === 0 || dialects.includes(spec.database))) {
  const name = `statement_events/server_transactions/${spec.database}`;
  let failed = 0;
  const check = (cond, message) => { if (!cond) { failed++; console.error(`FAIL ${name}: ${message}`); } };
  caseTest(name, DATABASE, async ({ step }) => {
    await withCaseDatabase(spec.database, step, database => runServerTransactions(spec, database.dsn, check));
    if (failed > 0) throw new Error(`${failed} check(s) failed; each FAIL line above names one`);
  });
}
if (failures > 0) process.exitCode = 1;
