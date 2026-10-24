// CFG-6: MySQL and PostgreSQL cancel statements that exceed their configured
// connection timeout, then keep the connection usable. Each case owns and
// removes a fresh database through case-database.mjs.
import { Author, Service, ServiceMember, ServiceRegion, User, connect } from '../dist/index.js';
import { caseTest, DATABASE } from '../../../tests/testcase.mts';
import { installBench } from './bench-set.mjs';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';

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
    try {
      await connection.query('START TRANSACTION');
      await connection.query('UPDATE `author` SET `seq` = `seq`');
    } catch (error) {
      const cleanupErrors = [];
      try { await connection.query('ROLLBACK'); } catch (cleanup) { cleanupErrors.push(cleanup); }
      try { await connection.end(); } catch (cleanup) { cleanupErrors.push(cleanup); }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'locking rows and cleaning up failed');
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const failures = [];
      try { await connection.query('ROLLBACK'); } catch (error) { failures.push(error); }
      try { await connection.end(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'rolling back and closing the MySQL lock connection failed');
    };
  }

  const client = postgresClient(dsn);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE "author" SET "seq" = "seq"');
  } catch (error) {
    const cleanupErrors = [];
    try { await client.query('ROLLBACK'); } catch (cleanup) { cleanupErrors.push(cleanup); }
    try { await client.end(); } catch (cleanup) { cleanupErrors.push(cleanup); }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'locking rows and cleaning up failed');
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const failures = [];
    try { await client.query('ROLLBACK'); } catch (error) { failures.push(error); }
    try { await client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'rolling back and closing the PostgreSQL lock connection failed');
  };
}

async function verifyDialect(dialect, database, step) {
  const db = await connect(database.dsn);
  let bounded;
  let release;
  let primaryFailure;
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
    const cleanupErrors = [];
    if (release) try { await release(); } catch (error) { cleanupErrors.push(error); }
    if (bounded) try { await bounded.close(); } catch (error) { cleanupErrors.push(error); }
    try { await db.close(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      if (primaryFailure) throw new AggregateError([primaryFailure, ...cleanupErrors], `${dialect}: timeout test and cleanup failed`);
      throw new AggregateError(cleanupErrors, `${dialect}: timeout test cleanup failed`);
    }
  }
  if (primaryFailure) throw primaryFailure;
}

// Requirements: CFG-6. The cases use the database lock as the slow statement,
// not a timer or a sleep in the statement under test.
caseTest('connection/statement-timeout-canceled', DATABASE, async ({ step }) => {
  for (const dialect of ['mysql', 'postgres']) {
    await withCaseDatabase(dialect, step, database => verifyDialect(dialect, database, step));
  }
});
