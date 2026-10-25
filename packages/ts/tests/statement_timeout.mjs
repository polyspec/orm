// CFG-6: MySQL and PostgreSQL cancel statements that exceed their configured
// connection timeout, then keep the connection usable. Each case owns and
// removes a fresh database through case-database.mjs.
import {
  Author, CORE, Db, Model, Service, ServiceMember, ServiceRegion, User, connect,
  dbspecManifest, parseDbspec, registerModel,
} from '../dist/index.js';
import { caseTest, COMPUTE, DATABASE } from '../../../tests/testcase.mts';
import { installBench } from './bench-set.mjs';
import { caseName, mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';
import { schemaOf } from './schema_of.mjs';

function documentModel(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const [entity] = model.entities.values();
  const Probe = class extends Model {};
  Probe.entity = { model, entity, create: core => new Probe(core) };
  return Probe;
}

async function holdConnectionRows(connection, begin, lock, releaseFailure) {
  try {
    await connection.query(begin);
    await connection.query(lock);
  } catch (error) {
    const cleanupErrors = [];
    try { await connection.query('ROLLBACK'); } catch (cleanup) { cleanupErrors.push(cleanup); }
    try { await connection.end(); } catch (cleanup) { cleanupErrors.push(cleanup); }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'locking rows and cleaning up failed', { cause: error });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const failures = [];
    try { await connection.query('ROLLBACK'); } catch (error) { failures.push(error); }
    try { await connection.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, releaseFailure);
  };
}

async function holdPoolerRows(dsn, table) {
  const client = postgresClient(dsn);
  await client.connect();
  return holdConnectionRows(client, 'BEGIN', `UPDATE "${table}" SET "seq" = "seq"`,
    'rolling back and closing the PostgreSQL lock connection failed');
}

async function dropPoolerTable(dsn, table) {
  const client = postgresClient(dsn);
  await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS "${table}"`);
  } finally {
    await client.end();
  }
}

async function lockedReadModel(db, ModelClass) {
  // Keep the same parameterized SELECT across transactions and client handles.
  await db.transaction(async () => { await new ModelClass().seq(1).forUpdate().get(); }, { retry: 0 });
}

async function seed(db) {
  const service = await new Service().connect(db).setName('timeout-service').create();
  const user = await new User().connect(db).setName('timeout-user').create();
  const region = await new ServiceRegion().connect(db).setServiceSeq(service.getSeq()).setName('timeout-region').create();
  const member = await new ServiceMember().connect(db).setServiceSeq(service.getSeq()).setUserSeq(user.getSeq()).create();
  await new Author().connect(db)
    .setName('timeout-author')
    .setUserSeq(user.getSeq())
    .setServiceSeq(service.getSeq())
    .setServiceRegionSeq(region.getSeq())
    .setServiceMemberSeq(member.getSeq())
    .setStartDt('2026-01-02 03:04:05')
    .setEndDt('2026-01-04 03:04:05')
    .setReadCount(0)
    .setIsClose(false)
    .create();
}

async function holdRows(dialect, dsn) {
  if (dialect === 'mysql') {
    const connection = await mysqlConnection(dsn);
    return holdConnectionRows(connection, 'START TRANSACTION', 'UPDATE `author` SET `seq` = `seq`',
      'rolling back and closing the MySQL lock connection failed');
  }

  const client = postgresClient(dsn);
  await client.connect();
  return holdConnectionRows(client, 'BEGIN', 'UPDATE "author" SET "seq" = "seq"',
    'rolling back and closing the PostgreSQL lock connection failed');
}

async function collectCleanupErrors(errors, actions) {
  for (const action of actions) {
    if (!action) continue;
    try { await action(); } catch (error) { errors.push(error); }
  }
}

async function verifyDialect(dialect, database, step) {
  const db = await connect(database.dsn);
  let bounded;
  let release;
  let primaryFailure;
  const cleanupErrors = [];
  try {
    await installBench(db);
    await seed(db);
    bounded = await connect(database.dsn, { poolSize: 1, statementTimeoutMs: 200 });
    release = await holdRows(dialect, database.dsn);
    let failure;
    try {
      await bounded.transaction(async () => new Author().forUpdate().get(), { retry: 0 });
    } catch (error) {
      failure = error;
    }
    if (failure?.code !== 'CANCELED') {
      throw new Error(`${dialect}: statement past statementTimeoutMs failed with ${failure?.code ?? 'no error'}: ${failure?.message ?? ''}`);
    }
    step(`${dialect}: the blocked statement returned CANCELED`);
    await release();
    release = undefined;
    const count = await new Author().connect(bounded).getCount();
    if (typeof count !== 'number' || count !== 1) throw new Error(`${dialect}: connection reuse returned count ${String(count)}, expected 1`);
    step(`${dialect}: the same connection completed a statement after the timeout`);
  } catch (error) {
    primaryFailure = error;
  } finally {
    await collectCleanupErrors(cleanupErrors, [
      release && (() => release()),
      bounded && (() => bounded.close()),
      () => db.close(),
    ]);
  }
  if (cleanupErrors.length && primaryFailure) throw new AggregateError([primaryFailure, ...cleanupErrors], `${dialect}: timeout test and cleanup failed`, { cause: primaryFailure });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `${dialect}: timeout test cleanup failed`, { cause: cleanupErrors[0] });
  if (primaryFailure) throw primaryFailure;
}

// Requirements: CFG-6. The cases use the database lock as the slow statement,
// not a timer or a sleep in the statement under test.
caseTest('connection/statement-timeout-negative-refused', COMPUTE, async () => {
  let failure;
  try {
    await connect('mysql://orm@127.0.0.1:1/timeout', { statementTimeoutMs: -1 });
  } catch (error) {
    failure = error;
  }
  if (failure?.code !== 'CONFIG' || !String(failure.message).includes('statement timeout')) {
    throw new Error(`negative statementTimeoutMs failed with ${failure?.code ?? 'no error'}: ${failure?.message ?? ''}`);
  }
});

caseTest('connection/statement-timeout-canceled', DATABASE, async ({ step }) => {
  for (const dialect of ['mysql', 'postgres']) {
    await withCaseDatabase(dialect, step, database => verifyDialect(dialect, database, step));
  }
});

// Requirements: CFG-27, CFG-28, CFG-29. This verifies the pooler applies the tracked timeout
// to the bounded client, while a client without a timeout keeps the server default.
caseTest('connection/statement-timeout-through-pooler', DATABASE, async ({ step }) => {
  const single = process.env.ORM_TEST_PGBOUNCER_SINGLE_DSN;
  const base = process.env.ORM_TEST_POSTGRES_DSN;
  if (!single) throw new Error('ORM_TEST_PGBOUNCER_SINGLE_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers');
  if (!base) throw new Error('ORM_TEST_POSTGRES_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers');
  const table = caseName();
  const probeText = `dbspec 1 pooler_probe\n\ntable ${table} {\n  seq i64 identity\n  label varchar(32)\n  primary key (seq)\n}\n`;
  const Probe = documentModel(probeText);
  const schema = schemaOf(probeText);
  let setup;
  let bounded;
  let plain;
  let release;
  let primaryFailure;
  const cleanupErrors = [];
  try {
    setup = await Db.connect(single);
    await setup.utils().schema().install(schema);
    for (let i = 0; i < 4; i++) {
      const row = new Probe().connect(setup);
      row[CORE].setValue('label', `probe-${i}`);
      await row.create();
    }
    step(`table ${table} created`);
    bounded = await Db.connectSchema(single, schema, { statementTimeoutMs: 200 });
    plain = await Db.connectSchema(single, schema);
    // Both client sessions issue the same locking query repeatedly through PgBouncer.
    for (let i = 0; i < 6; i++) {
      await lockedReadModel(bounded, Probe);
      await lockedReadModel(plain, Probe);
    }
    release = await holdPoolerRows(base, table);
    try {
      await lockedReadModel(bounded, Probe);
      throw new Error('the bounded connection through the pooler completed its locked read');
    } catch (error) {
      if (error?.code !== 'CANCELED') throw error;
    }
    await release();
    release = undefined;
    const count = await new Probe().connect(bounded).getCount();
    if (count !== 4) throw new Error(`the bounded connection returned ${count} rows after its timed out statement, expected 4`);
    step('the bounded client timed out and reused its connection');

    release = await holdPoolerRows(base, table);
    let releasePromise;
    let releaseFailure;
    const releaseOnce = () => {
      releasePromise ??= release();
      return releasePromise;
    };
    const held = setTimeout(() => { releaseOnce().catch(error => { releaseFailure = error; }); }, 400);
    const started = Date.now();
    let waitFailure;
    try {
      await lockedReadModel(plain, Probe);
      if (Date.now() - started < 200) throw new Error('the plain client did not wait past the bounded client timeout');
    } catch (error) {
      waitFailure = error;
    }
    clearTimeout(held);
    try { await releaseOnce(); } catch (error) {
      if (waitFailure) throw new AggregateError([waitFailure, error], 'the plain client wait and row-lock release failed', { cause: error });
      throw error;
    }
    release = undefined;
    if (waitFailure) throw waitFailure;
    if (releaseFailure) throw releaseFailure;
    step('the unbounded client waited past the bounded client timeout');

    release = await holdPoolerRows(base, table);
    try {
      await lockedReadModel(bounded, Probe);
      throw new Error('the bounded client stopped enforcing its timeout after the plain client');
    } catch (error) {
      if (error?.code !== 'CANCELED') throw error;
    }
    await release();
    release = undefined;
  } catch (error) {
    primaryFailure = error;
  } finally {
    await collectCleanupErrors(cleanupErrors, [
      release && (() => release()),
      bounded && (() => bounded.close()),
      plain && (() => plain.close()),
      setup && (() => setup.close()),
    ]);
    try { await dropPoolerTable(single, table); step(`table ${table} dropped`); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length && primaryFailure) throw new AggregateError([primaryFailure, ...cleanupErrors], 'pooler timeout test and cleanup failed', { cause: primaryFailure });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'pooler timeout test cleanup failed', { cause: cleanupErrors[0] });
  if (primaryFailure) throw primaryFailure;
});

// Requirements: CFG-31. This verifies that PgBouncer forwards a client cancel
// request to the server connection running the blocked statement.
caseTest('connection/cancellation-through-pooler', DATABASE, async ({ step }) => {
  const single = process.env.ORM_TEST_PGBOUNCER_SINGLE_DSN;
  const base = process.env.ORM_TEST_POSTGRES_DSN;
  if (!single) throw new Error('ORM_TEST_PGBOUNCER_SINGLE_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers');
  if (!base) throw new Error('ORM_TEST_POSTGRES_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers');
  const table = caseName();
  const probeText = `dbspec 1 pooler_probe\n\ntable ${table} {\n  seq i64 identity\n  label varchar(32)\n  primary key (seq)\n}\n`;
  const Probe = documentModel(probeText);
  const schema = schemaOf(probeText);
  let setup;
  let client;
  let release;
  let primaryFailure;
  const cleanupErrors = [];
  try {
    setup = await Db.connect(single);
    await setup.utils().schema().install(schema);
    for (let i = 0; i < 4; i++) {
      const row = new Probe().connect(setup);
      row[CORE].setValue('label', `probe-${i}`);
      await row.create();
    }
    client = await Db.connectSchema(single, schema);
    release = await holdPoolerRows(base, table);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    let cancellation;
    try {
      await lockedReadModel(client.withSignal(controller.signal), Probe);
    } catch (error) {
      cancellation = error;
    } finally {
      clearTimeout(timer);
    }
    if (cancellation?.code !== 'CANCELED') {
      throw new Error(`the statement through PgBouncer failed with ${cancellation?.code ?? 'no error'}, expected CANCELED`);
    }
    await release();
    release = undefined;
    const count = await new Probe().connect(client).getCount();
    if (count !== 4) throw new Error(`the connection returned ${count} rows after cancellation, expected 4`);
    step('PgBouncer forwarded cancellation and the client connection remained usable');
  } catch (error) {
    primaryFailure = error;
  } finally {
    await collectCleanupErrors(cleanupErrors, [
      release && (() => release()),
      client && (() => client.close()),
      setup && (() => setup.close()),
    ]);
    try { await dropPoolerTable(single, table); step(`table ${table} dropped`); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length && primaryFailure) throw new AggregateError([primaryFailure, ...cleanupErrors], 'pooler cancellation test and cleanup failed', { cause: primaryFailure });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'pooler cancellation test cleanup failed', { cause: cleanupErrors[0] });
  if (primaryFailure) throw primaryFailure;
});
