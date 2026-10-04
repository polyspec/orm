// tests/events/vectors.json의 statement event case를 TypeScript client로 MySQL, PostgreSQL,
// SQLite에서 실행한다(statement-events-run.mjs). case마다 새 case database(case-database.mjs)를 쓴다.
//
// Usage: node clients/typescript/tests/statement-events.mjs [--dialect mysql|postgres|sqlite]... [case ...]
// (after npm run typescript:build)
import { DATABASE, runCase } from '../../../tests/testcase.mjs';
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
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip`);
}
let failures = 0;
for (const dialect of dialects.length > 0 ? dialects : ['mysql', 'postgres', 'sqlite']) {
  for (const c of cases) {
    const name = `statement_events/${c.id}/${dialect}`;
    let failed = 0;
    const check = (cond, message) => { if (!cond) { failed++; console.error(`FAIL ${name}: ${message}`); } };
    const passed = await runCase(name, DATABASE, async ({ step }) => {
      await withCaseDatabase(dialect, step, database => runEventCase(c, dialect, database.dsn, check));
      if (failed > 0) throw new Error(`${failed} check(s) failed; each FAIL line above names one`);
    });
    if (!passed) failures++;
  }
}
if (failures > 0) process.exitCode = 1;
