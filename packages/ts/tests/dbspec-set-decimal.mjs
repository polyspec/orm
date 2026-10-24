// The decimal document set (contracts/fixtures/decimal_schema.dbs, listed by contracts/fixtures/dbspec-set.json) in the
// TypeScript client: the set parses and its manifest installs on SQLite, MySQL and PostgreSQL, and the generated model of
// its decimal table stores and reads each amount exactly. schema-set.mjs uses this set with the bench set in its several-
// schema cases; this file is the case of the set itself, so the unit reports the document under its file name.
// Each database is a case database of its own (case-database.mjs); ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the test
// servers, and the test fails when either is unset.
//
// Requirements: SCH-7, DBS-108.
// Usage: node packages/ts/tests/dbspec-set-decimal.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { CORE, Db } from '../dist/index.js';
import { caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { manifestOf, models } from './registered_models.mjs';

// CASE_DEADLINE_MS is the deadline of one database: the case installs the set and stores two rows.
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
}

const decimalText = await readFile(new URL('../../../contracts/fixtures/decimal_schema.dbs', import.meta.url), 'utf8');
const { manifestText, manifestHash } = manifestOf(decimalText);
const schema = { manifestText, manifestHash };
const { decimal_case: DecimalCase } = models(decimalText);
if (DecimalCase === undefined) throw new Error('the decimal set declares no decimal_case table');

const row = (db, seq, amount) => { const m = new DecimalCase().connect(db); m[CORE].setValue('seq', seq); m[CORE].setValue('amount', amount); return m; };
const amountOf = async (db, seq) => (await new DecimalCase().connect(db).seq(seq).get())[CORE].column('amount');

/** Installs the set, stores two amounts at the edges of decimal(13,4) and reads them back exactly. */
async function decimalDocument(dsn) {
  const db = await Db.connect(dsn);
  try {
    await db.utils().schema().install(schema);
    await row(db, 1, '48.0450').create();
    await row(db, 2, '123456789.1234').create();
    check(await new DecimalCase().connect(db).getCount() === 2, 'decimal rows after two inserts');
    check(await amountOf(db, 1) === '48.0450', 'decimal amount 48.0450 reads back');
    check(await amountOf(db, 2) === '123456789.1234', 'decimal amount 123456789.1234 reads back');
  } finally { await db.close(); }
}

caseTest('decimal_schema.dbs', 3 * CASE_DEADLINE_MS, async ({ step }) => {
  const before = failures;
  for (const driver of ['sqlite', 'mysql', 'postgres']) {
    current = `decimal_schema.dbs/${driver}`;
    await withCaseDatabase(driver, step, database => decimalDocument(database.dsn));
  }
  if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
});
if (failures > 0) process.exitCode = 1;
