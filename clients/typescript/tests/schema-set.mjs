// Several dbspec document sets in one process, on SQLite, MySQL and
// PostgreSQL. The bench set (schema/bench.dbs) and the decimal set
// (contracts/fixtures/decimal_schema.dbs) declare their models as generated
// code does, each with the manifest hash of its own set. A connection plans
// only the sets registered on it: the connect helper of generated code
// (Db.connectSchema) and install register a set, and a raw connection
// registers none. A request of a set that is not registered on its
// connection fails with SCHEMA_HASH_MISMATCH before any statement, also when
// another connection installed the set. A manifest text that does not hash to
// its declared hash fails with CONFIG when it is connected or installed.
// Each case runs on a case database of its own (case-database.mjs).
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name the test servers; the
// test fails when either is unset.
//
// Usage: node clients/typescript/tests/schema-set.mjs [case ...] (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { runCase } from '../../../tests/testcase.mjs';
import { withCaseDatabase } from './case-database.mjs';

const benchText = await readFile(new URL('../../../schema/bench.dbs', import.meta.url), 'utf8');
const decimalText = await readFile(new URL('../../../contracts/fixtures/decimal_schema.dbs', import.meta.url), 'utf8');
// CASE_DEADLINE_MS는 case 하나의 기한이다. case 하나는 database를 만들고 schema set 몇 개를 설치하고 읽은 뒤 지운다.
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
// generated code가 내보내는 schema 값: manifest text와 선언한 manifestHash다.
const benchSchema = { manifestText: bench.manifestText, manifestHash: bench.manifestHash };
const decimalSchema = { manifestText: decimal.manifestText, manifestHash: decimal.manifestHash };
const { user: User } = classes(registerModel(bench.manifestText, bench.manifestHash));
const decimalModel = registerModel(decimal.manifestText, decimal.manifestHash);
const { decimal_case: DecimalCase } = classes(decimalModel);
const user = (db, name) => { const m = new User().connect(db); m[CORE].setValue('name', name); return m; };
const decimalRow = (db, seq, amount) => { const m = new DecimalCase().connect(db); m[CORE].setValue('seq', seq); m[CORE].setValue('amount', amount); return m; };
const decimalAmount = async (db, seq) => (await new DecimalCase().connect(db).raw('{seq} = ?', seq).get())[CORE].column('amount');

/**
 * The bench helper connects, installs the bench set and the decimal set (the
 * decimal set twice; the second install changes nothing) and uses the models
 * of both sets in and outside a transaction.
 */
async function severalSchemas(dsn) {
  const db = await Db.connectSchema(dsn, benchSchema);
  try {
    for (const schema of [benchSchema, decimalSchema, decimalSchema]) await db.utils().schema().install(schema);
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
 * A request of a set that is not registered on its connection fails with
 * SCHEMA_HASH_MISMATCH before any statement: a raw connection registers no
 * set, and a connection of the bench helper does not register the decimal
 * set that another connection installed. A connection of the decimal helper
 * uses it.
 */
async function unregisteredSchema(dsn) {
  const statements = [];
  const onQuery = event => statements.push(event.sql);
  const raw = await Db.connect(dsn, { onQuery });
  try {
    check(await code(() => new User().connect(raw).getCount()) === 'SCHEMA_HASH_MISMATCH', 'bench read on a raw connection');
  } finally { await raw.close(); }
  const core = await Db.connectSchema(dsn, benchSchema, { onQuery });
  try {
    const installer = await Db.connectSchema(dsn, decimalSchema);
    try {
      await installer.utils().schema().install(decimalSchema);
      await decimalRow(installer, 1, '1.0000').create();
    } finally { await installer.close(); }
    check(await code(() => new DecimalCase().connect(core).getCount()) === 'SCHEMA_HASH_MISMATCH', 'decimal read on the bench connection');
    check(await code(() => decimalRow(core, 2, '2.0000').create()) === 'SCHEMA_HASH_MISMATCH', 'decimal write on the bench connection');
    check(statements.length === 0, `unregistered requests ran ${statements.length} statements`);
  } finally { await core.close(); }
  const decimal = await Db.connectSchema(dsn, decimalSchema);
  try {
    check(await new DecimalCase().connect(decimal).getCount() === 1, 'decimal rows through the decimal helper');
  } finally { await decimal.close(); }
}

/**
 * A manifest text that does not hash to its declared manifest hash fails with
 * CONFIG before any statement when it is connected or installed, and creates
 * nothing; generated code of that text fails with SCHEMA_HASH_MISMATCH when it
 * loads.
 */
async function editedManifest(dsn) {
  const edited = { manifestText: decimal.manifestText.replaceAll('decimal(13,4)', 'decimal(14,4)'), manifestHash: decimal.manifestHash };
  check(edited.manifestText !== decimal.manifestText, 'edited manifest differs');
  check(await code(() => Db.connectSchema(dsn, edited)) === 'CONFIG', 'connect with an edited manifest');
  check(await code(() => registerModel(edited.manifestText, edited.manifestHash)) === 'SCHEMA_HASH_MISMATCH', 'generated code of an edited manifest');
  const statements = [];
  const db = await Db.connectSchema(dsn, decimalSchema, { onQuery: event => statements.push(event.sql) });
  try {
    check(await code(() => db.utils().schema().install(edited)) === 'CONFIG', 'install of an edited manifest');
    check(statements.length === 0, `the edited manifest ran ${statements.length} statements`);
    await db.utils().schema().install(decimalSchema);
    await decimalRow(db, 4, '123456789.1234').create();
    check(await decimalAmount(db, 4) === '123456789.1234', 'decimal(13,4) column after the edited manifest');
    check(await new DecimalCase().connect(db).getCount() === 1, 'decimal rows after the rejected manifest');
  } finally { await db.close(); }
}

const cases = { several_schemas: severalSchemas, unregistered_schema: unregisteredSchema, edited_manifest: editedManifest };
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
    const passed = await runCase(`schema-set/${current}`, CASE_DEADLINE_MS, async ({ step }) => {
      await withCaseDatabase(driver, step, database => run(database.dsn));
      if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
    });
    if (!passed && failures === before) failures++;
  }
}
if (failures > 0) process.exitCode = 1;
