// A transaction or savepoint whose callback fails and whose rollback fails
// too, on SQLite, MySQL and PostgreSQL, with the fixture
// contracts/fixtures/rollback.dbs. The client reports one OrmError with
// the code ROLLBACK and the message `transaction failed (<cause>) and rollback
// failed (<rollback error>)` that keeps the callback error as its cause and
// the rollback error as its rollback. The callback runs only model calls. On
// SQLite a trigger that the test creates raises ROLLBACK when a row labeled
// `end` is inserted, which ends the transaction, so the client's ROLLBACK
// finds no transaction. On MySQL and PostgreSQL a test connection ends the
// server session that holds the transaction, so the next statement and the
// rollback fail; that connection reaches the server through
// ORM_TEST_MYSQL_SERVER_DSN or ORM_TEST_POSTGRES_SERVER_DSN (the make targets
// set them to the server DSNs of TEST_ENV), not through a pooler. Each case
// runs on a case database of its own on the servers of ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN, or a new SQLite file (case-database.mjs); the test
// fails when one of the four DSNs is unset.
//
// The rollback_fault case sets a rollback fault in the test entry point that resolves only under condition `orm-test`
// of `@polyspec/orm/testing`.
//
// Usage: node --conditions=orm-test packages/ts/tests/rollback.mjs [case ...] (after npm run typescript:build)
import { DatabaseSync } from 'node:sqlite';
import * as packageEntry from '../dist/index.js';
import { mysqlConnection, postgresClient, relatedDsn, withCaseDatabase } from './case-database.mjs';
import { registerDatabaseCases } from './database-case-tests.mjs';
import { CORE, Db, OrmError } from '../dist/index.js';
import { failNextRollback } from '@polyspec/orm/testing';
import { schemaOf } from './schema_of.mjs';
import { loadDatabaseCaseFixture } from './database-case-fixture.mjs';
import { checkConditionalEntry } from './conditional-entry.mjs';

const { text: rollbackText, model: RollbackProbe, deadline: CASE_DEADLINE_MS, state, check, raised } =
  await loadDatabaseCaseFixture('rollback.dbs', 'rollback_probe');
const probe = (db, label) => { const m = new RollbackProbe().connect(db); m[CORE].setValue('label', label); return m; };

/** Runs statements on a connection of the test, outside the client, and returns the rows of the last one. */
async function native(driver, dsn, statements) {
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await mysqlConnection(dsn);
    try { let rows = []; for (const s of statements) [rows] = await conn.query(s); return rows; } finally { await conn.end(); }
  }
  if (driver === 'postgres') {
    const client = postgresClient(dsn);
    await client.connect();
    try { let rows = []; for (const s of statements) ({ rows } = await client.query(s)); return rows; } finally { await client.end(); }
  }
  const db = new DatabaseSync(url.pathname);
  try { for (const s of statements) db.exec(s); return []; } finally { db.close(); }
}

/** Opens the client, installs the fixture and, on SQLite, creates the trigger that raises ROLLBACK. */
async function connect(driver, dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install(schemaOf(rollbackText));
  if (driver === 'sqlite') {
    await native(driver, dsn, ["CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END"]);
  }
  return db;
}

/**
 * Ends the server session that holds a lock on rollback_probe in the case
 * database of dsn; SQLite needs none, its trigger ends the transaction. The
 * test connects to that database through ORM_TEST_MYSQL_SERVER_DSN or
 * ORM_TEST_POSTGRES_SERVER_DSN, the server itself, because a pooler in front
 * of it may handle the statement on its own: ProxySQL takes a text-protocol
 * KILL as a command for its own client sessions. The lock on the table of the
 * case database marks the session that holds the transaction behind the
 * pooler.
 */
async function endSession(driver, dsn) {
  if (driver === 'sqlite') return;
  const env = `ORM_TEST_${driver.toUpperCase()}_SERVER_DSN`;
  const server = process.env[env];
  if (!server) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
  // The case database name is the path of the case DSN. The server connection also opens that database.
  const session = relatedDsn(server, new URL(dsn).pathname.slice(1));
  if (driver === 'postgres') {
    const rows = await native(driver, session, ["SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1"]);
    check(rows.length === 1, 'the transaction session holds a lock on rollback_probe');
    await native(driver, session, [`SELECT pg_terminate_backend(${Number(rows[0].pid)}, 5000)`]);
  } else {
    const rows = await native(driver, session, ["SELECT t.PROCESSLIST_ID AS id FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' LIMIT 1"]);
    check(rows.length === 1, 'the transaction session holds a lock on rollback_probe');
    await native(driver, session, [`KILL ${Number(rows[0].id)}`]);
  }
}

/** Checks a ROLLBACK error: both errors are kept and the message names both. */
function checkRollback(error, subject) {
  check(error instanceof OrmError, `${subject} raises ${error}`);
  check(error?.code === 'ROLLBACK', `${subject} code ${error?.code}: ${error?.message}`);
  check(error?.cause !== undefined, `${subject} keeps the callback error`);
  check(error?.rollback !== undefined, `${subject} keeps the rollback error`);
  if (error?.cause !== undefined && error?.rollback !== undefined) {
    const want = `ROLLBACK: transaction failed (${error.cause.message}) and rollback failed (${error.rollback.message})`;
    check(error.message === want, `${subject} message ${JSON.stringify(error.message)}, want ${JSON.stringify(want)}`);
  }
}

/** The callback of a transaction fails and the rollback fails. */
async function rollbackFailed(driver, dsn) {
  const db = await connect(driver, dsn);
  try {
    const error = await raised(() => db.transaction(async () => {
      await probe(db, 'kept').create();
      await endSession(driver, dsn);
      await probe(db, 'end').create();
    }, { retry: 0 }));
    checkRollback(error, 'transaction');
    if (driver !== 'sqlite') {
      // The next statement and rollback on a session the server has ended are connection-lost errors.
      check(error?.cause?.code === 'CONNECTION_LOST', `the callback error is CONNECTION_LOST: ${error?.cause?.code} ${error?.cause?.message}`);
      check(error?.rollback?.code === 'CONNECTION_LOST', `the rollback error is CONNECTION_LOST: ${error?.rollback?.code} ${error?.rollback?.message}`);
    }
    if (driver === 'sqlite') {
      check(String(error?.cause?.message).includes('rollback probe ended the transaction'), `callback error ${error?.cause?.message}`);
      check(await new RollbackProbe().connect(db).getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
    }
  } finally { await db.close(); }
}

/** The callback of a savepoint fails and the savepoint rollback fails, and then the transaction rollback fails. */
async function savepointRollbackFailed(driver, dsn) {
  const db = await connect(driver, dsn);
  try {
    const error = await raised(() => db.transaction(async () => {
      await probe(db, 'kept').create();
      await db.transaction(async () => {
        await probe(db, 'nested').create();
        await endSession(driver, dsn);
        await probe(db, 'end').create();
      });
    }, { retry: 0 }));
    checkRollback(error, 'transaction');
    checkRollback(error?.cause, 'savepoint');
    if (driver === 'sqlite') check(await new RollbackProbe().connect(db).getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
  } finally { await db.close(); }
}

/**
 * The test entry point resolves only under condition `orm-test`, and the package entry point
 * does not export the fault.
 */
function checkFaultEntry() {
  const packageRoot = new URL('..', import.meta.url).pathname;
  const { withoutCondition: plain, withCondition: tested } = checkConditionalEntry('@polyspec/orm/testing', 'orm-test', packageRoot);
  check(plain.status !== 0 && plain.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'), `the test entry point resolves without the condition orm-test: status ${plain.status} ${plain.stderr}`);
  check(tested.status === 0, `the test entry point does not resolve under the condition orm-test: ${tested.stderr}`);
  check(!('failNextRollback' in packageEntry) && !('armRollbackFault' in packageEntry), 'the package entry point exports the rollback fault');
}

/**
 * The rollback fault of the test entry point. A committed transaction leaves the fault in place,
 * and the next transaction whose callback fails is rolled back, and that rollback reports FAULT
 * and the transaction throws a ROLLBACK that carries both the callback error and the fault. The fault
 * is consumed: after that, the transaction throws only the callback error, and the connection
 * handles later requests.
 */
// Requirements: INT-72.
async function rollbackFault(driver, dsn) {
  checkFaultEntry();
  const db = await connect(driver, dsn);
  try {
    failNextRollback(db);
    const committed = await raised(() => db.transaction(async () => { await probe(db, 'committed').create(); }, { retry: 0 }));
    check(committed === undefined, `a committed transaction with an armed fault raises ${committed}`);
    const callback = new Error('rollback fault callback failed');
    const failing = async () => { await probe(db, 'rolled back').create(); throw callback; };
    const error = await raised(() => db.transaction(failing, { retry: 0 }));
    checkRollback(error, 'transaction');
    check(error?.cause === callback, 'the ROLLBACK error keeps the callback error itself');
    check(error?.rollback instanceof OrmError && error.rollback.code === 'FAULT', `the rollback error is FAULT: ${error?.rollback}`);
    check(await new RollbackProbe().connect(db).getCount() === 1, 'the faulted rollback keeps only the committed row');
    const again = await raised(() => db.transaction(failing, { retry: 0 }));
    check(again === callback, `the transaction after the consumed fault raises the callback error: ${again}`);
    check(await new RollbackProbe().connect(db).getCount() === 1, 'the second rollback keeps only the committed row');
  } finally { await db.close(); }
}

// Requirements: CFG-15.
const cases = { rollback_failed: rollbackFailed, savepoint_rollback_failed: savepointRollbackFailed, rollback_fault: rollbackFault };
registerDatabaseCases({
  feature: 'rollback', cases, deadline: CASE_DEADLINE_MS, withDatabase: withCaseDatabase,
  getFailures: () => state.failures, setCurrent: value => { state.current = value; },
  runCase: (run, _name, driver, database) => run(driver, database.dsn),
});
if (state.failures > 0) process.exitCode = 1;
