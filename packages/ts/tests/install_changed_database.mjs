// The install fixture of the TypeScript client, contracts/fixtures/install/changed_database.json. install compares the whole
// database with the set and not only its table names (docs/schema.md "Schema installation"): each case changes the database
// outside the ORM with a statement, installs the same set again, and gets the dialect's CONFIG message, and the database stays
// as the statement left it. Each case runs on a case database of its own (case-database.mjs) on SQLite, MySQL and PostgreSQL.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the test servers; the test fails when either is unset.
//
// Usage: node packages/ts/tests/install_changed_database.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { Db, OrmError, dbspecManifest, parseDbspec } from '../dist/index.js';
import { caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { nativeQuery } from './coverage_case.mjs';

// CASE_DEADLINE_MS is the deadline of one database case: a case builds a database, installs a set and runs statements.
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function thrown(run) {
  try { await run(); return null; } catch (error) { return error; }
}

/** The manifest of a document set. */
function manifestOf(text) {
  const parsed = parseDbspec(text, {});
  if (parsed.document === null) throw new Error(JSON.stringify(parsed.diagnostics));
  return dbspecManifest([parsed.document]).manifest;
}

for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
}
const installFixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/install/changed_database.json', import.meta.url), 'utf8'));
if (installFixture.cases.length === 0) throw new Error('contracts/fixtures/install/changed_database.json has no cases');

async function installVerifiesTheDatabase(c, dsn, driver) {
  check(c.operation === 'install', `${c.id}: the operation ${c.operation}, want install`);
  const text = await readFile(new URL(`../../../contracts/fixtures/${c.document}`, import.meta.url), 'utf8');
  const note = manifestOf(text);
  const schema = { manifestText: note.manifestText, manifestHash: note.manifestHash };
  const db = await Db.connect(dsn);
  try {
    await db.utils().schema().install(schema);
    await nativeQuery(driver, dsn, [c.statement]);
    const want = `${c.expected.code}: ${c.expected.message[driver]}`;
    const error = await thrown(() => db.utils().schema().install(schema));
    check(error instanceof OrmError && error.code === c.expected.code && error.message === want, `${c.id}: install over the changed database: ${error?.code ?? ''} ${error?.message ?? 'no error'}, want ${want}`);
    await nativeQuery(driver, dsn, [c.remaining]);
  } finally { await db.close(); }
}

// Each case of the fixture is one test named by its case id, and it runs on the three databases.
for (const c of installFixture.cases) {
  caseTest(c.id, 3 * CASE_DEADLINE_MS, async ({ step }) => {
    const before = failures;
    for (const driver of ['sqlite', 'mysql', 'postgres']) {
      current = `${c.id}/${driver}`;
      await withCaseDatabase(driver, step, database => installVerifiesTheDatabase(c, database.dsn, driver));
    }
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
}
if (failures > 0) process.exitCode = 1;
