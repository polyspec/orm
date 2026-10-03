// addColumns on SQLite, MySQL and PostgreSQL. A database holds the audit log
// tables of one manifest and the tables of a module manifest at version 1,
// with rows. addColumns with version 2 adds the missing nullable and
// defaulted columns to the existing module tables, keeps the rows, replaces
// the audit triggers of the changed table so that they record the new
// columns, creates no missing table and leaves the tables of the log manifest
// unchanged; a repeated call adds nothing. A manifest that differs from the
// tables in any other way fails with SCHEMA_DIFFERS before any change. The
// fixtures are contracts/fixtures/add_columns_*.json. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name test databases; the test fails when either is
// unset.
//
// Usage: node clients/typescript/tests/add-columns.mjs [case ...] (after npm run typescript:build)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE, Db, Model, OrmError, registerSchema } from '../dist/index.js';
import { stringify } from '../node_modules/ordered-json/js/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const fixtures = new URL('../../../contracts/fixtures/', import.meta.url).pathname;
const work = await mkdtemp(join(tmpdir(), 'orm-ts-add-columns-'));
const ADDED = ['addcol_item.note', 'addcol_item.rank', 'addcol_item.archived', 'addcol_item.status', 'addcol_tag.color'];
const DIFFERS = ['required', 'removed', 'changed', 'nullable', 'default', 'index', 'unique'];
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function code(run) {
  try { await run(); return ''; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

const json = {};
for (const name of ['log', 'v1', 'v2', ...DIFFERS]) json[name] = await readFile(join(fixtures, `add_columns_${name}.json`), 'utf8');
const logPath = join(fixtures, 'add_columns_log.json');

/** A model class for each entity of a fixture manifest. */
function models(name) {
  const manifest = JSON.parse(json[name]);
  const entities = new Map(Object.values(manifest.entities).map(e => [e.name, {
    name: e.name, table: e.table, pk: e.pk, auto: e.auto, fulltext: [],
    columns: Object.fromEntries(e.columns.map(c => [c.name, { type: c.type, precision: c.precision, scale: c.scale, nullable: c.nullable ?? false, styles: c.styles }])),
  }]));
  const set = { hash: manifest.schema_hash, entities };
  registerSchema(set);
  const out = {};
  for (const entity of entities.keys()) {
    const model = class extends Model {};
    model.entity = { schema: entities.get(entity), set, create: core => new model(core) };
    out[entity] = model;
  }
  return out;
}
const log = models('log');
const v1 = models('v1');
const v2 = models('v2');

function model(Model, db, values) {
  const m = new Model().connect(db);
  for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
  return m;
}
async function rows(Model, db) {
  const q = new Model().connect(db).addAllColumns();
  q[CORE].orderBy('seq', false, []);
  return [...(await q.gets()).values()];
}

/** Drops the test tables with the database driver; SQLite uses a new file per run. */
async function dropTables(driver, dsn) {
  const statements = ['addcol_extra', 'addcol_tag', 'addcol_item', 'addcol_change', 'addcol_operation'].map(t => `DROP TABLE IF EXISTS ${t}`);
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    try { for (const s of statements) await conn.query(s); } finally { await conn.end(); }
  } else if (driver === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined, password: decodeURIComponent(url.password) || undefined });
    await client.connect();
    try { for (const s of [...statements, 'DROP FUNCTION IF EXISTS addcol_item_audit()']) await client.query(s); } finally { await client.end(); }
  } else {
    await rm(url.pathname, { force: true });
  }
}

/** Opens a connection with the log manifest and installs the log and version 1 with one item and one tag. */
async function installed(dsn) {
  const db = await Db.connect(dsn, logPath);
  await db.utils().schema().install(json.log);
  await db.utils().schema().install(json.v1);
  await db.transaction(async () => {
    await model(log.addcol_operation, db, { operation_uuid: 'op-1' }).create();
    await db.utils().setLocal('addcol.operation', 'op-1');
    const item = await model(v1.addcol_item, db, { uuid: 'item-1', label: 'first', enabled: true, price: '2.50' }).create();
    await model(v1.addcol_tag, db, { addcol_item_seq: item[CORE].column('seq'), name: 'red' }).create();
  }, { retry: 0 });
  return db;
}

/** The kind and after value of each audit change in order. */
async function changes(db) {
  return (await rows(log.addcol_change, db)).map(r => `${r[CORE].column('change_kind')} ${stringify(r[CORE].column('after_value').payload())}`);
}

/**
 * addColumns adds the missing columns of the existing tables, keeps their rows,
 * makes the audit triggers record the new columns, creates no missing table,
 * leaves the log tables unchanged and adds nothing when repeated; install then
 * creates the missing table.
 */
async function addColumns(dsn) {
  const db = await installed(dsn);
  try {
    const before = await changes(db);
    check(before.length === 1, `one change before: ${before.join(' | ')}`);
    const added = await db.utils().schema().addColumns(json.v2);
    check(JSON.stringify(added) === JSON.stringify(ADDED), `added ${added}`);
    await db.utils().schema().register(json.v2);
    const items = await rows(v2.addcol_item, db);
    check(items.length === 1, 'one item');
    const item = items[0];
    const value = column => item[CORE].column(column);
    check(value('label') === 'first' && value('enabled') === true && value('price') === '2.50', `item values kept: ${value('label')} ${value('enabled')} ${value('price')}`);
    check(value('note') === null && value('rank') === 3 && value('archived') === false && value('status') === 'new', `item defaults: ${value('note')} ${value('rank')} ${value('archived')} ${value('status')}`);
    const tags = await rows(v2.addcol_tag, db);
    check(tags.length === 1 && tags[0][CORE].column('name') === 'red' && tags[0][CORE].column('color') === null, 'tag values');
    check(JSON.stringify(await changes(db)) === JSON.stringify(before), 'log rows kept');
    await db.transaction(async () => {
      await model(log.addcol_operation, db, { operation_uuid: 'op-2' }).create();
      await db.utils().setLocal('addcol.operation', 'op-2');
      item[CORE].setValue('note', 'later');
      item[CORE].setValue('rank', 4);
      await item.update();
    }, { retry: 0 });
    const after = await changes(db);
    check(after.length === 2 && after[1] === 'UPDATE {"note":"later","rank":4}', `update change ${after[1]}`);
    check(await code(() => new v2.addcol_extra().connect(db).getCount()) === 'DRIVER', 'missing table is not created');
    check((await db.utils().schema().addColumns(json.v2)).length === 0, 'repeated addColumns adds nothing');
    await db.utils().schema().install(json.v2);
    check(await new v2.addcol_extra().connect(db).getCount() === 0, 'install creates the missing table');
    check((await db.utils().schema().addColumns(json.v2)).length === 0, 'addColumns after install adds nothing');
  } finally { await db.close(); }
}

/** Every other difference fails with SCHEMA_DIFFERS before any change. */
async function addColumnsDiffers(dsn) {
  const db = await installed(dsn);
  try {
    for (const name of DIFFERS) check(await code(() => db.utils().schema().addColumns(json[name])) === 'SCHEMA_DIFFERS', `${name} returns SCHEMA_DIFFERS`);
    check(JSON.stringify(await db.utils().schema().addColumns(json.v2)) === JSON.stringify(ADDED), 'no column was added before');
  } finally { await db.close(); }
}

/**
 * MySQL commits schema statements implicitly, so addColumns inside a
 * transaction returns CONFIG there; PostgreSQL and SQLite add the columns in
 * the active transaction, and its rollback removes them.
 */
async function addColumnsTransaction(dsn) {
  const db = await installed(dsn);
  try {
    if (db.driver === 'mysql') {
      check(await code(() => db.transaction(() => db.utils().schema().addColumns(json.v2), { retry: 0 })) === 'CONFIG', 'MySQL transaction');
    } else {
      const rollback = new Error('roll back');
      let error;
      try {
        await db.transaction(async () => {
          check(JSON.stringify(await db.utils().schema().addColumns(json.v2)) === JSON.stringify(ADDED), 'added in the transaction');
          throw rollback;
        }, { retry: 0 });
      } catch (e) { error = e; }
      check(error === rollback, `callback error ${error}`);
    }
    check(JSON.stringify(await db.utils().schema().addColumns(json.v2)) === JSON.stringify(ADDED), 'the transaction added no column');
  } finally { await db.close(); }
}

/** addColumns verifies the manifest hash against its content before any statement runs. */
async function addColumnsEditedManifest(dsn) {
  const db = await installed(dsn);
  try {
    const edited = json.v2.replaceAll('"note"', '"memo"');
    check(edited !== json.v2, 'edited manifest differs');
    check(await code(() => db.utils().schema().addColumns(edited)) === 'CONFIG', 'edited manifest');
    check(JSON.stringify(await db.utils().schema().addColumns(json.v2)) === JSON.stringify(ADDED), 'the edited manifest added no column');
  } finally { await db.close(); }
}

const cases = { add_columns: addColumns, add_columns_differs: addColumnsDiffers, add_columns_transaction: addColumnsTransaction, add_columns_edited_manifest: addColumnsEditedManifest };
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
const targets = { sqlite: `sqlite://${join(work, 'add-columns.sqlite')}` };
for (const [driver, env] of [['mysql', 'ORM_TEST_MYSQL_DSN'], ['postgres', 'ORM_TEST_POSTGRES_DSN']]) {
  const value = process.env[env];
  if (!value) throw new Error(`${env} is required; database tests never skip`);
  targets[driver] = value;
}
try {
  for (const name of selected) {
    const run = cases[name];
    if (run === undefined) throw new Error(`unknown case ${name}`);
    const before = failures;
    for (const [driver, dsn] of Object.entries(targets)) {
      current = `${name}/${driver}`;
      const start = performance.now();
      console.log(`RUN  ${current}`);
      try {
        await dropTables(driver, dsn);
        await run(dsn);
      } catch (error) {
        failures++;
        console.error(`FAIL ${current}: ${error?.stack ?? error}`);
      } finally {
        await dropTables(driver, dsn);
      }
      console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${current} ${((performance.now() - start) / 1000).toFixed(3)}s`);
    }
    if (failures === before) console.log(`CASE ${name} PASS`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript add columns test: ${failures} failures`);
  process.exit(1);
}
console.log(`typescript add columns test: ${selected.length} cases on ${Object.keys(targets).length} databases passed`);
