// Several dbspec document sets in one process, on SQLite, MySQL and
// PostgreSQL. The bench set (contracts/fixtures/bench/bench.dbs) and the decimal set
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
// The install fixture (contracts/fixtures/install/changed_database.json) runs in install_changed_database.mjs.
//
// Usage: node packages/ts/tests/schema-set.mjs [case ...] (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { CORE, Db, OrmError, registerModel } from '../dist/index.js';
import { withCaseDatabase } from './case-database.mjs';
import { registerDatabaseCases } from './database-case-tests.mjs';
import { classesFromModel, manifestOf } from './registered_models.mjs';

const benchText = await readFile(new URL('../../../contracts/fixtures/bench/bench.dbs', import.meta.url), 'utf8');
const decimalText = await readFile(new URL('../../../contracts/fixtures/decimal_schema.dbs', import.meta.url), 'utf8');
// CASE_DEADLINE_MS is the deadline of one case. A case creates a database, installs and reads a few schema sets, then drops it.
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function code(run) {
  try { await run(); return ''; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

// Registers models with the manifest text and manifestHash of each set, as generated code does.
const bench = manifestOf(benchText);
const decimal = manifestOf(decimalText);
// The schema value that generated code exports: the manifest text and the declared manifestHash.
const benchSchema = { manifestText: bench.manifestText, manifestHash: bench.manifestHash };
const decimalSchema = { manifestText: decimal.manifestText, manifestHash: decimal.manifestHash };
const { user: User } = classesFromModel(registerModel(bench.manifestText, bench.manifestHash));
const decimalModel = registerModel(decimal.manifestText, decimal.manifestHash);
const { decimal_case: DecimalCase } = classesFromModel(decimalModel);
const user = (db, name) => { const m = new User().connect(db); m[CORE].setValue('name', name); return m; };
const decimalRow = (db, seq, amount) => { const m = new DecimalCase().connect(db); m[CORE].setValue('seq', seq); m[CORE].setValue('amount', amount); return m; };
const decimalAmount = async (db, seq) => (await new DecimalCase().connect(db).seq(seq).get())[CORE].column('amount');

/**
 * The bench helper connects, installs the bench set and the decimal set (the
 * decimal set twice; the second install changes nothing) and uses the models
 * of both sets in and outside a transaction.
 */
// Requirements: SCH-7, DBS-108.
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
// Requirements: DBS-119.
async function unregisteredSchema(dsn) {
  const statements = [];
  const record = event => statements.push(event.sql);
  const raw = await Db.connect(dsn);
  raw.subscribe(record);
  try {
    check(await code(() => new User().connect(raw).getCount()) === 'SCHEMA_HASH_MISMATCH', 'bench read on a raw connection');
  } finally { await raw.close(); }
  const core = await Db.connectSchema(dsn, benchSchema);
  core.subscribe(record);
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
// Requirements: SCH-7, SCH-11, DBS-120.
async function editedManifest(dsn) {
  const edited = { manifestText: decimal.manifestText.replaceAll('decimal(13,4)', 'decimal(14,4)'), manifestHash: decimal.manifestHash };
  check(edited.manifestText !== decimal.manifestText, 'edited manifest differs');
  check(await code(() => Db.connectSchema(dsn, edited)) === 'CONFIG', 'connect with an edited manifest');
  check(await code(() => registerModel(edited.manifestText, edited.manifestHash)) === 'SCHEMA_HASH_MISMATCH', 'generated code of an edited manifest');
  const statements = [];
  const db = await Db.connectSchema(dsn, decimalSchema);
  db.subscribe(event => statements.push(event.sql));
  try {
    check(await code(() => db.utils().schema().install(edited)) === 'CONFIG', 'install of an edited manifest');
    check(statements.length === 0, `the edited manifest ran ${statements.length} statements`);
    await db.utils().schema().install(decimalSchema);
    await decimalRow(db, 4, '123456789.1234').create();
    check(await decimalAmount(db, 4) === '123456789.1234', 'decimal(13,4) column after the edited manifest');
    check(await new DecimalCase().connect(db).getCount() === 1, 'decimal rows after the rejected manifest');
  } finally { await db.close(); }
}

const externalTexts = {};
for (const name of ['core', 'core_extra', 'member', 'member_v2']) {
  externalTexts[name] = await readFile(new URL(`../../../contracts/fixtures/external/${name}.dbs`, import.meta.url), 'utf8');
}

const cases = {
  several_schemas: severalSchemas,
  unregistered_schema: unregisteredSchema,
  edited_manifest: editedManifest,
};
registerDatabaseCases({
  feature: 'schema-set', cases, deadline: CASE_DEADLINE_MS, withDatabase: withCaseDatabase,
  getFailures: () => failures, setCurrent: value => { current = value; },
  runCase: (run, _name, driver, database) => run(database.dsn, driver),
});
if (failures > 0) process.exitCode = 1;
