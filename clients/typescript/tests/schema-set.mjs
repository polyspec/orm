// Several schemas on one connection, on SQLite, MySQL and PostgreSQL. A core
// schema and a module schema register their models in one process. A
// connection opened with the core schema installs both manifests and plans
// each model request with the engine of that model's schema. A connection
// that has not installed the module schema rejects a module model request
// with SCHEMA_HASH_MISMATCH, and install rejects a manifest whose hash differs
// from its content. Register adds an installed schema to a connection without
// creating anything. ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name test
// databases; the test fails when either is unset.
//
// Usage: node clients/typescript/tests/schema-set.mjs [case ...] (after npm run typescript:build)
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE, Db, Model, OrmError, registerSchema } from '../dist/index.js';
import { buildManifest, encodeManifest } from '../dist/schema/build.js';
import { parseDiagram } from '../dist/schema/mermaid.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'orm-ts-schema-set-'));
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function code(run) {
  try { await run(); return ''; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

/** A manifest built from Mermaid, written to $work/$name.json, and a model class for each entity. */
async function generated(name, source) {
  const manifest = buildManifest([parseDiagram(source)]);
  const entities = new Map(Object.values(manifest.entities).map(e => [e.name, {
    name: e.name, table: e.table, pk: e.pk, auto: e.auto, fulltext: [],
    columns: Object.fromEntries(e.columns.map(c => [c.name, { type: c.type, nullable: c.nullable, styles: c.styles }])),
  }]));
  const set = { hash: manifest.schema_hash, entities };
  registerSchema(set);
  const models = {};
  for (const entity of entities.keys()) {
    const model = class extends Model {};
    model.entity = { schema: entities.get(entity), set, create: core => new model(core) };
    models[entity] = model;
  }
  const json = encodeManifest(manifest);
  const path = join(work, `${name}.json`);
  await writeFile(path, json);
  return { json, path, models };
}

const core = await generated('core', 'erDiagram\n  schema_set_note {\n    bigint seq PK "auto"\n    varchar(64) title\n  }\n');
const module = await generated('module', 'erDiagram\n  schema_set_item {\n    bigint seq PK "auto"\n    varchar(64) label\n    int amount\n  }\n');
const { schema_set_note: Note } = core.models;
const { schema_set_item: Item } = module.models;
const note = (db, title) => { const m = new Note().connect(db); m[CORE].setValue('title', title); return m; };
const item = (db, label, amount) => { const m = new Item().connect(db); m[CORE].setValue('label', label); m[CORE].setValue('amount', amount); return m; };
const ordered = (model, db) => { const q = new model().connect(db).addAllColumns(); q[CORE].orderBy('seq', false, []); return q; };

/** Drops the test tables with the database driver; SQLite uses a new file per run. */
async function dropTables(driver, dsn) {
  const tables = ['schema_set_item', 'schema_set_note'];
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    try { for (const table of tables) await conn.query(`DROP TABLE IF EXISTS ${table}`); } finally { await conn.end(); }
  } else if (driver === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined });
    await client.connect();
    try { for (const table of tables) await client.query(`DROP TABLE IF EXISTS ${table}`); } finally { await client.end(); }
  } else {
    await rm(url.pathname, { force: true });
  }
}

/** A connection opened with the core schema serves the models of both schemas after installing them. */
async function severalSchemas(dsn) {
  const db = await Db.connect(dsn, core.path);
  try {
    await db.utils().schema().install(core.json);
    await db.utils().schema().install(module.json);
    // A repeated install keeps the tables and the registered engine.
    await db.utils().schema().install(module.json);
    await note(db, 'core').create();
    await item(db, 'module', 7).create();
    await db.transaction(async () => {
      await note(db, 'core-tx').create();
      await item(db, 'module-tx', 8).create();
    }, { retry: 0 });
    const notes = [...(await ordered(Note, db).gets()).values()].map(r => r[CORE].column('title'));
    const items = [...(await ordered(Item, db).gets()).values()].map(r => `${r[CORE].column('label')}:${r[CORE].column('amount')}`);
    check(notes.join(',') === 'core,core-tx', `core rows ${notes}`);
    check(items.join(',') === 'module:7,module-tx:8', `module rows ${items}`);
    check(await new Item().connect(db).getCount() === 2, 'module count');
  } finally { await db.close(); }
}

/** A connection that has not installed the module schema rejects its models; no other engine plans them. */
async function unregisteredSchema(dsn) {
  const installer = await Db.connect(dsn, core.path);
  try {
    await installer.utils().schema().install(core.json);
    await installer.utils().schema().install(module.json);
  } finally { await installer.close(); }
  const db = await Db.connect(dsn, core.path);
  try {
    check(await code(() => new Item().connect(db).addAllColumns().gets()) === 'SCHEMA_HASH_MISMATCH', 'module read before install');
    check(await code(() => item(db, 'x', 1).create()) === 'SCHEMA_HASH_MISMATCH', 'module write before install');
    check(await new Note().connect(db).getCount() === 0, 'core read');
    await db.utils().schema().install(module.json);
    check(await new Item().connect(db).getCount() === 0, 'module read after install');
  } finally { await db.close(); }
}

/** Install verifies the manifest hash against its content before any statement runs. */
async function editedManifest(dsn) {
  const edited = module.json.replaceAll('"schema_set_item"', '"schema_set_edit"');
  check(edited !== module.json, 'edited manifest differs');
  const db = await Db.connect(dsn, core.path);
  try {
    check(await code(() => db.utils().schema().install(edited)) === 'CONFIG', 'install of an edited manifest');
    check(await code(() => new Item().connect(db).getCount()) === 'SCHEMA_HASH_MISMATCH', 'edited manifest is not registered');
  } finally { await db.close(); }
}

/**
 * Register adds the engine of an installed schema to a connection and creates
 * nothing: before installation the module table stays absent, and after
 * installation by another connection the module models read and write.
 */
async function registerSchemaCase(dsn) {
  const fresh = await Db.connect(dsn, core.path);
  try {
    await fresh.utils().schema().register(module.json);
    check(await code(() => new Item().connect(fresh).getCount()) === 'DRIVER', 'register creates no table');
  } finally { await fresh.close(); }
  const installer = await Db.connect(dsn, core.path);
  try {
    await installer.utils().schema().install(core.json);
    await installer.utils().schema().install(module.json);
  } finally { await installer.close(); }
  const db = await Db.connect(dsn, core.path);
  try {
    check(await code(() => new Item().connect(db).getCount()) === 'SCHEMA_HASH_MISMATCH', 'module read before register');
    await db.utils().schema().register(module.json);
    // A repeated register keeps the registered engine.
    await db.utils().schema().register(module.json);
    await item(db, 'registered', 3).create();
    check(await new Item().connect(db).amount(3).getCount() === 1, 'module write and read after register');
  } finally { await db.close(); }
}

/** Register verifies the manifest hash against its content and registers nothing when they differ. */
async function registerEditedManifest(dsn) {
  const edited = module.json.replaceAll('"schema_set_item"', '"schema_set_edit"');
  const db = await Db.connect(dsn, core.path);
  try {
    check(await code(() => db.utils().schema().register(edited)) === 'CONFIG', 'register of an edited manifest');
    check(await code(() => new Item().connect(db).getCount()) === 'SCHEMA_HASH_MISMATCH', 'edited manifest is not registered');
  } finally { await db.close(); }
}

const cases = { several_schemas: severalSchemas, unregistered_schema: unregisteredSchema, edited_manifest: editedManifest,
  register_schema: registerSchemaCase, register_edited_manifest: registerEditedManifest };
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
const targets = { sqlite: `sqlite://${join(work, 'schema-set.sqlite')}` };
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
  console.error(`typescript schema set test: ${failures} failures`);
  process.exit(1);
}
console.log(`typescript schema set test: ${selected.length} cases on ${Object.keys(targets).length} databases passed`);
