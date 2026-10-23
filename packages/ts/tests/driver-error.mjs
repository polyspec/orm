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
import { readFile } from 'node:fs/promises';
import { models } from './registered_models.mjs';
import { CORE, Db, OrmError, dbspecManifest, parseDbspec } from '../dist/index.js';
import { caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';

const refusalText = await readFile(new URL('../../../contracts/fixtures/refusal.dbs', import.meta.url), 'utf8');
// CASE_DEADLINE_MS is the deadline of one case. A case creates a case database, installs the refusal document, runs a few writes that are rejected, then drops the database.
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function raised(run) {
  try { await run(); return undefined; } catch (error) { return error; }
}

const { refused_row: RefusedRow } = models(refusalText);
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
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
}
for (const name of selected) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  for (const driver of ['sqlite', 'mysql', 'postgres']) {
    caseTest(`driver-error/${name}/${driver}`, CASE_DEADLINE_MS, async ({ step }) => {
      const before = failures;
      current = `${name}/${driver}`;
      await withCaseDatabase(driver, step, database => run(database.dsn));
      if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
    });
  }
}
if (failures > 0) process.exitCode = 1;
