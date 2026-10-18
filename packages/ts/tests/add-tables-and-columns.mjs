// Checks addTablesAndColumns on SQLite, MySQL, and PostgreSQL (docs/schema.md "Adding tables and
// columns"). The case database holds the addcol_log table of another set and the tables of addcol set version 1, together with their rows.
// With version 2, calling addTablesAndColumns adds to existing tables the columns that are missing and that are nullable or have a default,
// keeps the rows, has the audit trigger of the changed audit table record the new column, and creates missing tables
// with their index, foreign key, check, and audit trigger, and leaves the tables of other sets as they are. Calling it again
// adds nothing. It adds a missing index to an existing table, and a missing unique key is
// SCHEMA_DIFFERS that states its reason. A set with any other difference is SCHEMA_DIFFERS before anything is changed.
// The fixtures are contracts/fixtures/add_tables_and_columns/*.dbs. Each case runs in its own case
// database (case-database.mjs), and fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is missing.
// it fails.
//
// Usage: node packages/ts/tests/add-tables-and-columns.mjs [case ...] (after npm run typescript:build)
import { Db, OrmError, dbspecManifest, parseDbspec, readDbspecFile } from '../dist/index.js';
import { caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { nativeQuery } from './coverage_case.mjs';

// CASE_DEADLINE_MS is the deadline of one case. A case creates a database, installs two sets, and adds columns
// a few times, then drops the database.
const CASE_DEADLINE_MS = 60_000;
const ADDED = [
  'addcol_extra', 'addcol_extra_history',
  'addcol_item.note', 'addcol_item.priority', 'addcol_item.archived', 'addcol_item.status',
  'addcol_item_history.note', 'addcol_item_history.priority', 'addcol_item_history.archived', 'addcol_item_history.status',
  'addcol_tag.color',
];
const DIFFERS = ['required', 'removed', 'changed', 'nullable', 'default', 'unique', 'reorder'];
// The columns and indexes that index.dbs adds at version 1. The index comes after the columns.
const ADDED_INDEX = ['addcol_item.note', 'addcol_item.ix_addcol_item_label', 'addcol_item_history.note'];
const MISSING_UNIQUE = 'add_unique addcol_item.uq_addcol_item_label: a missing unique key can fail on the existing rows; add it with a plan';
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
/** The OrmError that the call rejected. null on success. */
async function thrown(run) {
  try { await run(); return null; } catch (error) { if (error instanceof OrmError) return error; throw error; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The schema value of contracts/fixtures/add_tables_and_columns/<name>.dbs. */
async function fixture(name) {
  const path = new URL(`../../../contracts/fixtures/add_tables_and_columns/${name}.dbs`, import.meta.url).pathname;
  const read = await readDbspecFile(path);
  if (read.text === null) throw new Error(`${path}: ${JSON.stringify(read.diagnostics)}`);
  const parsed = parseDbspec(read.text, {});
  if (parsed.document === null) throw new Error(`${path}: ${JSON.stringify(parsed.diagnostics)}`);
  const { manifest } = dbspecManifest([parsed.document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** Reads the number that the query returns over the native connection. */
async function countOf(driver, dsn, sql) {
  const [[row]] = await nativeQuery(driver, dsn, [sql]);
  return Number(Object.values(row)[0]);
}

/**
 * Installs addcol_log and version 1 in the case database, then creates one log row, one item with one audit record, and the
 * link that uses a tag and that tag's child tag.
 */
async function installed(driver, dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install(await fixture('log'));
  await db.utils().schema().install(await fixture('v1'));
  await nativeQuery(driver, dsn, [
    "INSERT INTO addcol_log_entry (message) VALUES ('kept')",
    "INSERT INTO audit (actor) VALUES ('setup')",
    "INSERT INTO addcol_item (ref, label, created_at, audit_seq) VALUES ('item-1', 'first', '2026-01-01 00:00:00.000000', 1)",
    "INSERT INTO addcol_tag (item_id, name) VALUES (1, 'red')",
    "INSERT INTO addcol_tag (item_id, parent_id, name) VALUES (1, 1, 'child')",
  ]);
  return db;
}

async function addTablesAndColumns(driver, dsn) {
  const db = await installed(driver, dsn);
  try {
    const added = await db.utils().schema().addTablesAndColumns(await fixture('v2'));
    check(same(added, ADDED), `addTablesAndColumns = ${JSON.stringify(added)}`);
    // The rows stay as they are, and the new columns are NULL or their default.
    const items = await countOf(driver, dsn, "SELECT COUNT(*) AS n FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'");
    check(items === 1, `items with their values and the new defaults ${items}`);
    check(await countOf(driver, dsn, 'SELECT COUNT(*) AS n FROM addcol_tag WHERE color IS NULL') === 2, 'tags with a null color');
    check(await countOf(driver, dsn, "SELECT COUNT(*) AS n FROM addcol_log_entry WHERE message = 'kept'") === 1, 'log entries');
    // SQLite turned off foreign keys and rebuilt the table. Checks that the connection turned them back on.
    const orphan = await thrown(() => db.pool.execute("INSERT INTO addcol_tag (item_id, name) VALUES (999, 'orphan')", [], undefined, () => undefined));
    check(orphan?.code === 'FOREIGN_KEY', `a tag of a missing item: ${orphan?.message ?? 'written'}`);
    // The audit trigger records the new column.
    await nativeQuery(driver, dsn, ["INSERT INTO audit (actor) VALUES ('update')", "UPDATE addcol_item SET note = 'later', priority = 4, audit_seq = 2 WHERE id = 1"]);
    const history = await countOf(driver, dsn, "SELECT COUNT(*) AS n FROM addcol_item_history WHERE history_action = 'update' AND previous_audit_seq = 1 AND audit_seq = 2 AND note = 'later' AND priority = 4 AND status = 'new'");
    check(history === 1, `history rows of the update with the new columns ${history}`);
    // The new table was created with its index, foreign key, check, and audit trigger.
    await nativeQuery(driver, dsn, ["INSERT INTO audit (actor) VALUES ('extra')", "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, 'extra', 3)"]);
    const inserted = await countOf(driver, dsn, "SELECT COUNT(*) AS n FROM addcol_extra_history WHERE history_action = 'insert' AND previous_audit_seq IS NULL AND audit_seq = 3 AND item_id = 1 AND label = 'extra'");
    check(inserted === 1, `history rows of the insert into the created table ${inserted}`);
    for (const [statement, what] of [
      ["INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (999, 'orphan', 3)", 'foreign key'],
      ["INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, '', 3)", 'check'],
      ['DELETE FROM addcol_extra', 'audit delete'],
    ]) {
      let refused = null;
      try { await nativeQuery(driver, dsn, [statement]); } catch (error) { refused = error; }
      check(refused !== null, `the ${what} of the created table accepted ${statement}`);
    }
    check(await countOf(driver, dsn, 'SELECT COUNT(*) AS n FROM addcol_extra') === 1, 'rows of the created table');
    const again = await db.utils().schema().addTablesAndColumns(await fixture('v2'));
    check(same(again, []), `repeated addTablesAndColumns = ${JSON.stringify(again)}`);
    // All tables exist, so install changes nothing (docs/schema.md "Schema installation").
    const install = await thrown(async () => db.utils().schema().install(await fixture('v2')));
    check(install === null, `install of version 2 over its tables: ${install?.message}`);
  } finally { await db.close(); }
}

async function addTablesAndColumnsDiffers(driver, dsn) {
  const db = await installed(driver, dsn);
  try {
    for (const name of DIFFERS) {
      const error = await thrown(async () => db.utils().schema().addTablesAndColumns(await fixture(name)));
      check(error?.code === 'SCHEMA_DIFFERS', `${name}: ${error?.message ?? 'no error'}`);
    }
    const added = await db.utils().schema().addTablesAndColumns(await fixture('v2'));
    check(same(added, ADDED), `addTablesAndColumns after the differences = ${JSON.stringify(added)}`);
  } finally { await db.close(); }
}

/** Adds a missing index to an existing table, and calling it again does nothing. A missing unique key is SCHEMA_DIFFERS with its reason stated. */
async function addTablesAndColumnsIndex(driver, dsn) {
  const db = await installed(driver, dsn);
  try {
    const unique = await thrown(async () => db.utils().schema().addTablesAndColumns(await fixture('unique')));
    check(unique?.code === 'SCHEMA_DIFFERS' && unique.message.includes(MISSING_UNIQUE), `a missing unique key: ${unique?.message ?? 'no error'}`);
    const index = await fixture('index');
    const added = await db.utils().schema().addTablesAndColumns(index);
    check(same(added, ADDED_INDEX), `addTablesAndColumns with a missing index = ${JSON.stringify(added)}`);
    const again = await db.utils().schema().addTablesAndColumns(index);
    check(same(again, []), `repeated addTablesAndColumns with the index = ${JSON.stringify(again)}`);
    // install changes nothing only when the database matches the set: the index exists as declared.
    const install = await thrown(() => db.utils().schema().install(index));
    check(install === null, `install of the set with the index: ${install?.message}`);
  } finally { await db.close(); }
}

async function addTablesAndColumnsTransaction(driver, dsn) {
  const db = await installed(driver, dsn);
  try {
    const v2 = await fixture('v2');
    if (driver === 'postgres') {
      const rollback = new Error('roll back');
      let failure = null;
      try {
        await db.transaction(async () => {
          const added = await db.utils().schema().addTablesAndColumns(v2);
          check(same(added, ADDED), `addTablesAndColumns in the transaction = ${JSON.stringify(added)}`);
          throw rollback;
        }, { retry: 0 });
      } catch (error) { failure = error; }
      check(failure === rollback, `the transaction did not roll back: ${failure}`);
    } else {
      let inside = null;
      await db.transaction(async () => { inside = await thrown(() => db.utils().schema().addTablesAndColumns(v2)); }, { retry: 0 });
      check(inside?.code === 'CONFIG', `addTablesAndColumns in a ${driver} transaction: ${inside?.message ?? 'no error'}`);
    }
    const added = await db.utils().schema().addTablesAndColumns(v2);
    check(same(added, ADDED), `addTablesAndColumns after the transaction = ${JSON.stringify(added)}`);
  } finally { await db.close(); }
}

async function addTablesAndColumnsEditedManifest(driver, dsn) {
  const db = await installed(driver, dsn);
  try {
    const v2 = await fixture('v2');
    const edited = { manifestText: v2.manifestText.replaceAll(' note ', ' memo '), manifestHash: v2.manifestHash };
    const error = await thrown(() => db.utils().schema().addTablesAndColumns(edited));
    check(error?.code === 'CONFIG', `addTablesAndColumns of an edited manifest: ${error?.message ?? 'no error'}`);
    const added = await db.utils().schema().addTablesAndColumns(v2);
    check(same(added, ADDED), `addTablesAndColumns after the edited manifest = ${JSON.stringify(added)}`);
  } finally { await db.close(); }
}

const cases = {
  add_tables_and_columns: addTablesAndColumns,
  add_tables_and_columns_differs: addTablesAndColumnsDiffers,
  add_tables_and_columns_index: addTablesAndColumnsIndex,
  add_tables_and_columns_transaction: addTablesAndColumnsTransaction,
  add_tables_and_columns_edited_manifest: addTablesAndColumnsEditedManifest,
};
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
}
for (const name of selected) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  for (const driver of ['sqlite', 'mysql', 'postgres']) {
    caseTest(`add-tables-and-columns/${name}/${driver}`, CASE_DEADLINE_MS, async ({ step }) => {
      const before = failures;
      current = `${name}/${driver}`;
      await withCaseDatabase(driver, step, database => run(driver, database.dsn));
      if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
    });
  }
}
if (failures > 0) process.exitCode = 1;
