// addTablesAndColumns를 SQLite, MySQL, PostgreSQL에서 확인한다(docs/schema.md "Adding tables and
// columns"). case database는 다른 set addcol_log의 table과 addcol set version 1의 table을 row와 함께
// 가진다. version 2로 addTablesAndColumns를 부르면 있는 table에 빠진 null이거나 default가 있는
// column을 더하고, row를 지키며, 바뀐 audit table의 trigger가 새 column을 기록하고, 없는 table을
// index, foreign key, check, audit trigger와 함께 만들며, 다른 set의 table은 그대로 둔다. 다시
// 부르면 아무것도 더하지 않는다. 있는 table에 빠진 index는 더하고, 빠진 unique key는 그 이유를 적은
// SCHEMA_DIFFERS다. 다른 차이가 있는 set은 아무것도 바꾸기 전에 SCHEMA_DIFFERS다.
// fixture는 contracts/fixtures/add_tables_and_columns/*.dbs다. 각 case는 자기 case
// database(case-database.mjs)에서 실행하며 ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이 없으면
// 실패한다.
//
// Usage: node clients/typescript/tests/add-tables-and-columns.mjs [case ...] (after npm run typescript:build)
import { Db, OrmError, dbspecManifest, parseDbspec, readDbspecFile } from '../dist/index.js';
import { runCase } from '../../../tests/testcase.mjs';
import { withCaseDatabase } from './case-database.mjs';
import { nativeQuery } from './coverage_case.mjs';

// CASE_DEADLINE_MS는 case 하나의 기한이다. case 하나는 database를 만들고 set 두 개를 설치하고 column을
// 몇 번 더한 뒤 지운다.
const CASE_DEADLINE_MS = 60_000;
const ADDED = [
  'addcol_extra', 'addcol_extra_history',
  'addcol_item.note', 'addcol_item.priority', 'addcol_item.archived', 'addcol_item.status',
  'addcol_item_history.note', 'addcol_item_history.priority', 'addcol_item_history.archived', 'addcol_item_history.status',
  'addcol_tag.color',
];
const DIFFERS = ['required', 'removed', 'changed', 'nullable', 'default', 'unique', 'reorder'];
// index.dbs가 version 1에 더하는 column과 index다. column 뒤에 index가 온다.
const ADDED_INDEX = ['addcol_item.note', 'addcol_item.ix_addcol_item_label', 'addcol_item_history.note'];
const MISSING_UNIQUE = 'add_unique addcol_item.uq_addcol_item_label: a missing unique key can fail on the existing rows; add it with a plan';
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
/** call이 reject한 OrmError다. 성공하면 null이다. */
async function thrown(run) {
  try { await run(); return null; } catch (error) { if (error instanceof OrmError) return error; throw error; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** contracts/fixtures/add_tables_and_columns/<name>.dbs의 schema 값이다. */
async function fixture(name) {
  const path = new URL(`../../../contracts/fixtures/add_tables_and_columns/${name}.dbs`, import.meta.url).pathname;
  const read = await readDbspecFile(path);
  if (read.text === null) throw new Error(`${path}: ${JSON.stringify(read.diagnostics)}`);
  const parsed = parseDbspec(read.text, {});
  if (parsed.document === null) throw new Error(`${path}: ${JSON.stringify(parsed.diagnostics)}`);
  const { manifest } = dbspecManifest([parsed.document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** native 연결로 query가 돌려주는 수를 읽는다. */
async function countOf(driver, dsn, sql) {
  const [[row]] = await nativeQuery(driver, dsn, [sql]);
  return Number(Object.values(row)[0]);
}

/**
 * case database에 addcol_log와 version 1을 설치하고 log row 하나, audit 기록 1로 item 하나, 그 item의
 * tag와 그 tag의 자식 tag를 쓴 연결이다.
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
    // row는 그대로이고 새 column은 NULL이거나 default다.
    const items = await countOf(driver, dsn, "SELECT COUNT(*) AS n FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'");
    check(items === 1, `items with their values and the new defaults ${items}`);
    check(await countOf(driver, dsn, 'SELECT COUNT(*) AS n FROM addcol_tag WHERE color IS NULL') === 2, 'tags with a null color');
    check(await countOf(driver, dsn, "SELECT COUNT(*) AS n FROM addcol_log_entry WHERE message = 'kept'") === 1, 'log entries');
    // SQLite는 foreign key를 끄고 table을 다시 만들었다. 연결이 다시 켰는지 본다.
    const orphan = await thrown(() => db.pool.execute("INSERT INTO addcol_tag (item_id, name) VALUES (999, 'orphan')", [], undefined, () => undefined));
    check(orphan?.code === 'FOREIGN_KEY', `a tag of a missing item: ${orphan?.message ?? 'written'}`);
    // audit trigger는 새 column을 기록한다.
    await nativeQuery(driver, dsn, ["INSERT INTO audit (actor) VALUES ('update')", "UPDATE addcol_item SET note = 'later', priority = 4, audit_seq = 2 WHERE id = 1"]);
    const history = await countOf(driver, dsn, "SELECT COUNT(*) AS n FROM addcol_item_history WHERE history_action = 'update' AND previous_audit_seq = 1 AND audit_seq = 2 AND note = 'later' AND priority = 4 AND status = 'new'");
    check(history === 1, `history rows of the update with the new columns ${history}`);
    // 새 table은 index, foreign key, check, audit trigger와 함께 만들어졌다.
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
    // 모든 table이 있으므로 install은 아무것도 바꾸지 않는다(docs/schema.md "Schema installation").
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

/** 있는 table에 빠진 index는 더하고 다시 부르면 아무것도 하지 않는다. 빠진 unique key는 그 이유를 적은 SCHEMA_DIFFERS다. */
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
    // install은 database가 set과 같을 때만 아무것도 바꾸지 않는다: index가 선언대로 있다.
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
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip`);
}
for (const name of selected) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  for (const driver of ['sqlite', 'mysql', 'postgres']) {
    const before = failures;
    current = `${name}/${driver}`;
    const passed = await runCase(`add-tables-and-columns/${current}`, CASE_DEADLINE_MS, async ({ step }) => {
      await withCaseDatabase(driver, step, database => run(driver, database.dsn));
      if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
    });
    if (!passed && failures === before) failures++;
  }
}
if (failures > 0) process.exitCode = 1;
