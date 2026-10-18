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
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { nativeQuery } from './coverage_case.mjs';

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

// Registers models with the manifest text and manifestHash of each set, as generated code does.
const bench = manifestOf(benchText);
const decimal = manifestOf(decimalText);
// The schema value that generated code exports: the manifest text and the declared manifestHash.
const benchSchema = { manifestText: bench.manifestText, manifestHash: bench.manifestHash };
const decimalSchema = { manifestText: decimal.manifestText, manifestHash: decimal.manifestHash };
const { user: User } = classes(registerModel(bench.manifestText, bench.manifestHash));
const decimalModel = registerModel(decimal.manifestText, decimal.manifestHash);
const { decimal_case: DecimalCase } = classes(decimalModel);
const user = (db, name) => { const m = new User().connect(db); m[CORE].setValue('name', name); return m; };
const decimalRow = (db, seq, amount) => { const m = new DecimalCase().connect(db); m[CORE].setValue('seq', seq); m[CORE].setValue('amount', amount); return m; };
const decimalAmount = async (db, seq) => (await new DecimalCase().connect(db).seq(seq).get())[CORE].column('amount');

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

/**
 * The generated schema value of a document set that owns the documents and uses the external documents: each
 * document is parsed with all others as its set and the external documents are marked external.
 */
function externalSchema(owned, external) {
  const texts = [...owned, ...external].map(name => externalTexts[name]);
  const headerName = text => text.slice('dbspec 1 '.length, text.indexOf('\n'));
  const documents = texts.map((text, i) => {
    const set = {};
    texts.forEach((other, j) => { if (j !== i) set[headerName(other)] = other; });
    const parsed = parseDbspec(text, set);
    if (parsed.document === null) throw new Error(JSON.stringify(parsed.diagnostics));
    return i >= owned.length ? Object.freeze({ ...parsed.document, external: true }) : parsed.document;
  });
  const { manifest } = dbspecManifest(documents);
  if (manifest === null) throw new Error('the external fixture set has no manifest');
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash, externalText: manifest.externalText };
}

/** The error a run throws, or null when it succeeds. */
async function thrown(run) {
  try { await run(); return null; } catch (error) { return error; }
}

/**
 * The externalCase of packages/go/orm/external_documents_test.go. The member set uses ext_account and ext_audit of ext_core
 * as uses, and owns only ext_post and ext_post_history (contracts/fixtures/external).
 * - If an external table is missing, install and addTablesAndColumns are CONFIG before any statement and do not create the member's
 *   tables. Registration does not read the database, so connectSchema connects even if the external tables are missing or differ.
 * - After core is installed, member install creates only the tables it owns, and running it again changes nothing. addTablesAndColumns
 *   adds columns only to the tables it owns.
 * - The member's audit transaction inserts a record into ext_audit, which core owns.
 * - If a writable table of an external document differs from the database (a missing column), it is CONFIG.
 */
async function externalDocuments(dsn, driver) {
  const core = manifestOf(externalTexts.core);
  const coreSchema = { manifestText: core.manifestText, manifestHash: core.manifestHash };
  const member = externalSchema(['member'], ['core']);
  const memberV2 = externalSchema(['member_v2'], ['core']);
  const drifted = externalSchema(['member'], ['core_extra']);
  const options = { auditSource: () => ({ actor: 'writer' }) };
  const expectConfig = (step, error, message) => {
    check(error instanceof OrmError && error.code === 'CONFIG' && error.message.includes(message), `${step}: ${error?.code ?? ''} ${error?.message ?? 'no error'}, want CONFIG with ${message}`);
  };
  const missing = 'the tables that the set uses from external documents differ from the database: table ext_account does not exist; table ext_audit does not exist';
  await (await Db.connectSchema(dsn, member, options)).close();
  const db = await Db.connect(dsn, options);
  try {
    const schema = db.utils().schema();
    const exists = async table => (await thrown(() => nativeQuery(driver, dsn, [`SELECT COUNT(*) AS n FROM ${table}`]))) === null;
    expectConfig('install before core', await thrown(() => schema.install(member)), missing);
    expectConfig('addTablesAndColumns before core', await thrown(() => schema.addTablesAndColumns(member)), missing);
    check(!(await exists('ext_post')), 'ext_post exists after the refused install');

    await schema.install(coreSchema);
    await nativeQuery(driver, dsn, ["INSERT INTO ext_account (name) VALUES ('kim')"]);
    for (let i = 0; i < 2; i++) await schema.install(member);
    for (const table of ['ext_post', 'ext_post_history']) check(await exists(table), `${table} exists after the member install`);
    const connected = await Db.connectSchema(dsn, member, options);
    await connected.close();

    const { ext_post: Post } = classes(registerModel(member.manifestText, member.manifestHash, member.externalText));
    await db.transaction(async () => {
      const post = new Post();
      post[CORE].setValue('account_seq', 1);
      post[CORE].setValue('title', 'hello');
      await post.create();
    }, { audit: {} });
    const [[record], [history]] = await nativeQuery(driver, dsn, ['SELECT seq, actor FROM ext_audit', 'SELECT audit_seq FROM ext_post_history']);
    check(record.actor === 'writer' && Number(history.audit_seq) === Number(record.seq), `audit record ${JSON.stringify(record)} and history ${JSON.stringify(history)}, want the record of writer in the history`);

    const unchanged = await schema.addTablesAndColumns(member);
    check(unchanged.length === 0, `addTablesAndColumns of the installed member: ${JSON.stringify(unchanged)}, want nothing`);
    const added = await schema.addTablesAndColumns(memberV2);
    check(JSON.stringify(added) === JSON.stringify(['ext_post.summary', 'ext_post_history.summary']), `addTablesAndColumns of member_v2: ${JSON.stringify(added)}`);
    const [[accounts]] = await nativeQuery(driver, dsn, ['SELECT COUNT(*) AS n FROM ext_account']);
    check(Number(accounts.n) === 1, `ext_account has ${accounts.n} rows after the member changes, want 1`);

    const differs = 'the tables that the set uses from external documents differ from the database: column ext_account.nick does not exist';
    await (await Db.connectSchema(dsn, drifted, options)).close();
    expectConfig('install with a drifted external table', await thrown(() => schema.install(drifted)), differs);
    expectConfig('addTablesAndColumns with a drifted external table', await thrown(() => schema.addTablesAndColumns(drifted)), differs);
  } finally { await db.close(); }
}

/**
 * Counts all statements the db's pool sent to the database, transaction starts, and reserved sessions. If registration calls the driver,
 * that count increases.
 */
function countStatements(db) {
  const counter = { sent: 0 };
  const pool = db.pool;
  for (const method of ['execute', 'begin', 'session']) {
    const original = pool[method];
    if (typeof original !== 'function') continue;
    pool[method] = (...args) => { counter.sent++; return original.apply(pool, args); };
  }
  return counter;
}

/**
 * Registration sends no statement to the database (docs/schema.md "Schema registration"). register does not read
 * external documents, and a set that writes them does not read the database either; text that does not hash to the declared hash is CONFIG without any statement. The requests of a registered bench
 * set run on that connection. connectSchema also connects to a database without the external tables.
 */
async function registerSendsNoStatement(dsn) {
  const member = externalSchema(['member'], ['core']);
  const installer = await Db.connect(dsn);
  try { await installer.utils().schema().install(benchSchema); } finally { await installer.close(); }
  const db = await Db.connect(dsn);
  try {
    const counter = countStatements(db);
    check(await code(() => new User().connect(db).getCount()) === 'SCHEMA_HASH_MISMATCH', 'bench read before the register');
    const before = counter.sent;
    db.utils().schema().register(benchSchema);
    db.utils().schema().register(benchSchema);
    db.utils().schema().register(member);
    const edited = { manifestText: decimal.manifestText.replaceAll('decimal(13,4)', 'decimal(14,4)'), manifestHash: decimal.manifestHash };
    check(await code(() => db.utils().schema().register(edited)) === 'CONFIG', 'register of a text that does not hash to its declared hash');
    check(counter.sent === before, `register sent ${counter.sent - before} statements, want 0`);
    const users = await new User().connect(db).getCount();
    check(users === 0, `bench read after the register: ${users} rows`);
  } finally { await db.close(); }
  // connectSchema also connects to this database, which lacks the external tables: registration does not read external tables.
  const connected = await Db.connectSchema(dsn, member);
  await connected.close();
}

const cases = {
  several_schemas: severalSchemas,
  unregistered_schema: unregisteredSchema,
  edited_manifest: editedManifest,
  external_documents: externalDocuments,
  register_sends_no_statement: registerSendsNoStatement,
};
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
}
for (const name of selected) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  for (const driver of ['sqlite', 'mysql', 'postgres']) {
    caseTest(`schema-set/${name}/${driver}`, CASE_DEADLINE_MS, async ({ step }) => {
      const before = failures;
      current = `${name}/${driver}`;
      await withCaseDatabase(driver, step, database => run(database.dsn, driver));
      if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
    });
  }
}
if (failures > 0) process.exitCode = 1;
