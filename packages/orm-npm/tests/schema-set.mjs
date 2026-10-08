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
// Usage: node packages/orm-npm/tests/schema-set.mjs [case ...] (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { runCase } from '../../../tests/testcase.mjs';
import { withCaseDatabase } from './case-database.mjs';
import { nativeQuery } from './coverage_case.mjs';

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
 * packages/orm-go/orm/external_documents_test.go 의 externalCase 다. member set 은 ext_core 의 ext_account 와 ext_audit 을
 * use 로 쓰고 ext_post 와 ext_post_history 만 소유한다(contracts/fixtures/external).
 * - 외부 table 이 없으면 install, addTablesAndColumns 가 어떤 statement 보다 먼저 CONFIG 이고 member 의 table 을
 *   만들지 않는다. 등록은 database 를 읽지 않으므로 connectSchema 는 외부 table 이 없거나 달라도 연결한다.
 * - core 를 설치한 뒤 member install 은 소유한 table 만 만들고, 다시 하면 아무것도 바꾸지 않는다. addTablesAndColumns 는
 *   소유한 table 에만 column 을 더한다.
 * - member 의 audit transaction 은 core 가 소유한 ext_audit 에 기록을 삽입한다.
 * - 외부 문서의 쓰는 table 이 database 와 다르면(없는 column) CONFIG 다.
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
 * db 의 pool 이 database 에 보낸 statement, transaction 시작, 예약한 session 을 모두 센다. 등록이 driver 를 부르면
 * 그 수가 는다.
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
 * 등록은 database 에 아무 statement 도 보내지 않는다(docs/schema.md "Schema registration"). register 는 외부 문서를
 * 쓰는 set 도 database 를 읽지 않고, 선언한 hash 로 hash 되지 않는 text 는 statement 없이 CONFIG 다. 등록한 bench
 * set 의 요청은 그 연결에서 실행된다. connectSchema 는 외부 table 이 없는 database 에서도 연결한다.
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
  // connectSchema 는 외부 table 이 없는 이 database 에서도 연결한다: 등록은 외부 table 을 읽지 않는다.
  const connected = await Db.connectSchema(dsn, member);
  await connected.close();
}

/**
 * install 은 table 이름만이 아니라 database 전체를 set 과 비교한다(docs/schema.md "Schema installation").
 * contracts/fixtures/install/changed_database.json 의 case 마다 statement 로 ORM 밖에서 바꾼 database 에 같은 set 을
 * 다시 install 하면 dialect 의 message 인 CONFIG 이고 database 는 그대로다.
 */
async function installVerifiesTheDatabase(dsn, driver) {
  const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/install/changed_database.json', import.meta.url), 'utf8'));
  check(fixture.cases.length > 0, 'contracts/fixtures/install/changed_database.json has no cases');
  for (const c of fixture.cases) {
    check(c.operation === 'install', `${c.id}: the operation ${c.operation}, want install`);
    const text = await readFile(new URL(`../../../contracts/fixtures/${c.document}`, import.meta.url), 'utf8');
    const note = manifestOf(text);
    const schema = { manifestText: note.manifestText, manifestHash: note.manifestHash };
    const db = await Db.connect(dsn);
    try {
      await db.utils().schema().install(schema);
      await nativeQuery(driver, dsn, [c.statement]);
      const want = `${c.expected.code}: ${c.expected.message[driver]}`;
      const error = await thrown(() => db.utils().schema().install(schema));
      check(error instanceof OrmError && error.code === c.expected.code && error.message === want, `${c.id}: install over the changed database: ${error?.code ?? ''} ${error?.message ?? 'no error'}, want ${want}`);
      await nativeQuery(driver, dsn, [c.remaining]);
      // 다음 case 는 같은 case database 를 쓰므로 이 case 의 table 을 지운다.
      await nativeQuery(driver, dsn, parseDbspec(text, {}).document.tables.map(t => `DROP TABLE ${t.name}`));
    } finally { await db.close(); }
  }
}

const cases = {
  several_schemas: severalSchemas,
  unregistered_schema: unregisteredSchema,
  edited_manifest: editedManifest,
  external_documents: externalDocuments,
  register_sends_no_statement: registerSendsNoStatement,
  install_verifies_the_database: installVerifiesTheDatabase,
};
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
}
for (const name of selected) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  for (const driver of ['sqlite', 'mysql', 'postgres']) {
    const before = failures;
    current = `${name}/${driver}`;
    const passed = await runCase(`schema-set/${current}`, CASE_DEADLINE_MS, async ({ step }) => {
      await withCaseDatabase(driver, step, database => run(database.dsn, driver));
      if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
    });
    if (!passed && failures === before) failures++;
  }
}
if (failures > 0) process.exitCode = 1;
