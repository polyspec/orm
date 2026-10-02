// Several dbspec document sets in one process, on SQLite, MySQL and
// PostgreSQL. The bench set (schema/bench.dbs) and the decimal set
// (contracts/fixtures/decimal_schema.dbs) register their models as
// generated code does, each with the manifest hash of its own set, and any
// connection plans a request with the runtime model of the request's
// manifest hash. A set whose tables another connection installed is used
// without any registration call. Generated code whose manifest text does not
// hash to its declared hash, and a request whose manifest hash no loaded
// generated code registered, fail with SCHEMA_HASH_MISMATCH before any
// statement. Each case runs on its own new database (a new SQLite file).
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the test servers; the
// test fails when either is unset.
//
// Usage: node clients/typescript/tests/schema-set.mjs [case ...] (after npm run typescript:build)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const benchText = await readFile(new URL('../../../schema/bench.dbs', import.meta.url), 'utf8');
const decimalText = await readFile(new URL('../../../contracts/fixtures/decimal_schema.dbs', import.meta.url), 'utf8');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-schema-set-'));
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function code(run) {
  try { await run(); return ''; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

/** The manifest of a document set. */
function manifestOf(text) {
  const parsed = parseDbspec(text, {});
  if (parsed.document === null) throw new Error(JSON.stringify(parsed.diagnostics));
  return dbspecManifest([parsed.document]).manifest;
}

/** A model class per entity of a runtime model, as generated code declares them. */
function classes(model) {
  const out = {};
  for (const entity of model.entities.values()) {
    const cls = class extends Model {};
    cls.entity = { model, entity, create: core => new cls(core) };
    out[entity.name] = cls;
  }
  return out;
}

// generated code처럼 각 set의 manifest text와 manifestHash로 model을 등록한다.
const bench = manifestOf(benchText);
const decimal = manifestOf(decimalText);
const { user: User } = classes(registerModel(bench.manifestText, bench.manifestHash));
const decimalModel = registerModel(decimal.manifestText, decimal.manifestHash);
const { decimal_case: DecimalCase } = classes(decimalModel);
const user = (db, name) => { const m = new User().connect(db); m[CORE].setValue('name', name); return m; };
const decimalRow = (db, seq, amount) => { const m = new DecimalCase().connect(db); m[CORE].setValue('seq', seq); m[CORE].setValue('amount', amount); return m; };
const decimalAmount = async (db, seq) => (await new DecimalCase().connect(db).raw('{seq} = ?', seq).get())[CORE].column('amount');

/** Connects with the server's own driver to the database of dsn. */
async function server(driver, dsn) {
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    return { run: async sql => { await conn.query(sql); }, end: () => conn.end() };
  }
  const { Client } = require('pg');
  const client = new Client({ host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined, password: decodeURIComponent(url.password) || undefined });
  await client.connect();
  return { run: async sql => { await client.query(sql); }, end: () => client.end() };
}

let databases = 0;
/** Creates a new database for one case and returns its DSN and its cleanup; SQLite takes a new file. */
async function newDatabase(driver, dsn) {
  databases++;
  if (driver === 'sqlite') {
    const path = join(work, `schema-set-${databases}.sqlite`);
    return { dsn: `sqlite://${path}`, drop: () => rm(path, { force: true }) };
  }
  const name = `orm_schema_set_${process.pid}_${databases}`;
  const admin = await server(driver, dsn);
  try { await admin.run(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const url = new URL(dsn);
  url.pathname = `/${name}`;
  return {
    dsn: url.toString(),
    drop: async () => {
      const again = await server(driver, dsn);
      try { await again.run(`DROP DATABASE ${name}${driver === 'postgres' ? ' WITH (FORCE)' : ''}`); } finally { await again.end(); }
    },
  };
}

/**
 * A connection installs the bench set and the decimal set (the decimal set
 * twice; the second install changes nothing) and uses the models of both sets
 * in and outside a transaction.
 */
async function severalSchemas(dsn) {
  const db = await Db.connect(dsn);
  try {
    for (const text of [benchText, decimalText, decimalText]) await db.utils().schema().install([text]);
    await user(db, 'core').create();
    await decimalRow(db, 1, '48.0450').create();
    await db.transaction(async () => {
      await user(db, 'core-tx').create();
      await decimalRow(db, 2, '1.5000').create();
    }, { retry: 0 });
    check(await new User().connect(db).getCount() === 2, 'bench rows');
    check(await decimalAmount(db, 1) === '48.0450', 'decimal amount');
    check(await new DecimalCase().connect(db).getCount() === 2, 'decimal rows');
  } finally { await db.close(); }
}

/**
 * Before installation a decimal read fails with DRIVER and creates nothing;
 * after another connection installs the decimal set, the first connection
 * reads and writes decimal rows without any registration call.
 */
async function installedElsewhere(dsn) {
  const db = await Db.connect(dsn);
  try {
    check(await code(() => new DecimalCase().connect(db).getCount()) === 'DRIVER', 'decimal read before installation');
    const installer = await Db.connect(dsn);
    try {
      for (const text of [benchText, decimalText]) await installer.utils().schema().install([text]);
    } finally { await installer.close(); }
    await decimalRow(db, 3, '2.5000').create();
    check(await decimalAmount(db, 3) === '2.5000', 'decimal row after installation elsewhere');
  } finally { await db.close(); }
}

/**
 * Generated code whose manifest text differs from its declared manifest hash
 * is rejected with SCHEMA_HASH_MISMATCH before any statement, also when that
 * hash is already registered and its engine cached on the connection, and the
 * table stays unchanged.
 */
async function editedManifest(dsn) {
  const statements = [];
  const db = await Db.connect(dsn, { onQuery: event => statements.push(event.sql) });
  try {
    await db.utils().schema().install([decimalText]);
    check(await new DecimalCase().connect(db).getCount() === 0, 'decimal rows before the edited manifest');
    const edited = decimal.manifestText.replaceAll('decimal(13,4)', 'decimal(14,4)');
    check(edited !== decimal.manifestText, 'edited manifest differs');
    const before = statements.length;
    check(await code(() => registerModel(edited, decimal.manifestHash)) === 'SCHEMA_HASH_MISMATCH', 'generated code of an edited manifest');
    check(statements.length === before, `the edited manifest ran ${statements.length - before} statements`);
    check(registerModel(decimal.manifestText, decimal.manifestHash) === decimalModel, 'the registered model stays');
    await decimalRow(db, 4, '123456789.1234').create();
    check(await decimalAmount(db, 4) === '123456789.1234', 'decimal(13,4) column after the edited manifest');
    check(await new DecimalCase().connect(db).getCount() === 1, 'decimal rows after the rejected manifest');
  } finally { await db.close(); }
}

/** A request whose manifest hash no loaded generated code registered fails with SCHEMA_HASH_MISMATCH; no other model plans it. */
async function unregisteredSchema(dsn) {
  const statements = [];
  const db = await Db.connect(dsn, { onQuery: event => statements.push(event.sql) });
  try {
    await db.utils().schema().install([decimalText]);
    // 같은 table을 담지만 등록되지 않은 document set의 hash를 가진 model이다.
    const unloaded = manifestOf(decimalText.replace('dbspec 1 decimal_schema', 'dbspec 1 decimal_unloaded'));
    check(unloaded.manifestHash !== decimal.manifestHash, 'the unloaded set has its own manifest hash');
    const { decimal_case: Unloaded } = classes({ ...decimalModel, manifestText: unloaded.manifestText, manifestHash: unloaded.manifestHash });
    const before = statements.length;
    check(await code(() => new Unloaded().connect(db).getCount()) === 'SCHEMA_HASH_MISMATCH', 'read of an unregistered manifest');
    check(await code(() => { const m = new Unloaded().connect(db); m[CORE].setValue('seq', 5); m[CORE].setValue('amount', '1.0000'); return m.create(); }) === 'SCHEMA_HASH_MISMATCH', 'write of an unregistered manifest');
    check(statements.length === before, `the unregistered manifest ran ${statements.length - before} statements`);
    check(await new DecimalCase().connect(db).getCount() === 0, 'decimal rows after the rejected requests');
  } finally { await db.close(); }
}

const cases = { several_schemas: severalSchemas, installed_elsewhere: installedElsewhere, edited_manifest: editedManifest, unregistered_schema: unregisteredSchema };
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
const targets = { sqlite: '' };
for (const [driver, env] of [['mysql', 'ORM_TEST_MYSQL_DSN'], ['postgres', 'ORM_TEST_POSTGRES_DSN']]) {
  const value = process.env[env];
  if (!value) throw new Error(`${env} is required; database tests never skip`);
  targets[driver] = value;
}
try {
  for (const name of selected) {
    const run = cases[name];
    if (run === undefined) throw new Error(`unknown case ${name}`);
    const caseBefore = failures;
    for (const [driver, base] of Object.entries(targets)) {
      const before = failures;
      current = `${name}/${driver}`;
      const start = performance.now();
      console.log(`RUN  ${current}`);
      let timer;
      let database;
      try {
        database = await newDatabase(driver, base);
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${CASE_DEADLINE_MS} ms`)), CASE_DEADLINE_MS); });
        await Promise.race([run(database.dsn), deadline]);
      } catch (error) {
        failures++;
        console.error(`FAIL ${current}: ${error?.stack ?? error}`);
      } finally {
        clearTimeout(timer);
        try { await database?.drop(); } catch (error) { failures++; console.error(`FAIL ${current}: drop database: ${error?.stack ?? error}`); }
      }
      console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${current} ${((performance.now() - start) / 1000).toFixed(3)}s`);
    }
    if (failures === caseBefore) console.log(`CASE ${name} PASS`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript schema set test: ${failures} failures`);
  process.exit(1);
}
console.log(`typescript schema set test: ${selected.length} cases on ${Object.keys(targets).length} databases passed`);
