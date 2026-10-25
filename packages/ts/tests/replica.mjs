// A connection to the primary and one to its replica side by side (docs/spec/config.md "Primary and replicas"), on MySQL
// and PostgreSQL, and a connection to a SQLite database file that the process may only read. A model uses the connection
// it is connected to and no other, a model without a connection inside a transaction uses the transaction, and a write
// through the replica or to the read-only file returns READ_ONLY. Each case runs on a case database of its own on the
// servers of ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, whose replicas ORM_TEST_MYSQL_REPLICA_DSN and
// ORM_TEST_POSTGRES_REPLICA_DSN name, or a new SQLite file (case-database.mjs); a missing variable fails the case.
// Requirements: CFG-21, CFG-22, CFG-23, CFG-24, CFG-25.
//
// Usage: node packages/ts/tests/replica.mjs (after npm run typescript:build)
import { chmod } from 'node:fs/promises';
import { OrmError, User, connect as connectBench } from '../dist/index.js';
import { DATABASE, caseTest } from '../../../tests/testcase.mts';
import { installBench } from './bench-set.mjs';
import { mysqlConnection, postgresClient, relatedDsn, withCaseDatabase } from './case-database.mjs';
import { createFailureCheck } from './check-state.mjs';

let failures = 0;
let current = '';
const check = createFailureCheck(() => current, () => { failures++; });

async function code(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

function connect(dsn) {
  return connectBench(dsn, { aesKey: 'test-aes-key', blindIndexKey: 'test-blind-key' });
}

async function install(dsn) {
  const db = await connect(dsn);
  try { await installBench(db); } finally { await db.close(); }
}

/**
 * Returns after the replica has applied every change the primary committed
 * before the call. On PostgreSQL a transaction with
 * synchronous_commit=remote_apply that writes WAL, here a transactional
 * logical message, commits after the standby has applied it; a transaction
 * that writes no WAL besides its commit record does not wait. On MySQL
 * SOURCE_POS_WAIT on the replica waits for the binary log position of the
 * primary.
 */
async function awaitReplica(dialect, primary, replica) {
  if (dialect === 'postgres') {
    const client = postgresClient(primary);
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = remote_apply');
      const mode = (await client.query("SELECT current_setting('synchronous_commit') AS mode, pg_logical_emit_message(true, 'orm-test-barrier', '')")).rows[0].mode;
      if (mode !== 'remote_apply') throw new Error(`synchronous_commit of the barrier transaction is ${mode}`);
      await client.query('COMMIT');
    } finally { await client.end(); }
    return;
  }
  // The replica may not have the case database yet, so both connections open without a database. If one connection
  // fails, the open connection is still closed. An open connection would keep the test process from ending.
  const source = await mysqlConnection(primary, null);
  try {
    const target = await mysqlConnection(replica, null);
    try {
      const [[{ current: selected }]] = await target.query('SELECT DATABASE() AS current');
      if (selected !== null) throw new Error(`the replica wait connection opened database ${selected}`);
      const [[status]] = await source.query('SHOW BINARY LOG STATUS');
      // The deadline is 60 seconds: the replica applies the writes of all clients that run in parallel, one after another, so on a 4 vCPU Linux
      // runner it could not reach the primary position within 10 seconds.
      const [[{ waited }]] = await target.query('SELECT SOURCE_POS_WAIT(?, ?, 60) AS waited', [status.File, status.Position]);
      if (waited === null || Number(waited) < 0) throw new Error(`the replica did not reach ${status.File}:${status.Position}`);
    } finally { await target.end(); }
  } finally { await source.end(); }
}

/**
 * Opens a connection to the primary and one to its replica side by side. A
 * model uses the connection it is connected to and no other, and a model
 * without a connection inside a transaction uses the transaction.
 */
async function primaryAndReplica(dialect, primary, replica) {
  await install(primary);
  const master = await connect(primary);
  let slave1;
  try {
    const name = `replica-${process.hrtime.bigint()}`;
    await new User().connect(master).setName(name).create();
    await awaitReplica(dialect, primary, replica);
    slave1 = await connect(replica);
    check(await new User().connect(slave1).name(name).getCount() === 1, 'the replica reads the row written through the primary');
    check(await code(new User().connect(slave1).setName(`${name}-replica`).create()) === 'READ_ONLY', 'a write through the replica connection is rejected');
    check(await new User().connect(master).name(`${name}-replica`).getCount() === 0, 'a write through the replica connection does not reach the primary');
    // A row read through the replica is written through the primary.
    await (await new User().connect(slave1).name(name).get()).connect(master).setName(`${name}-renamed`).update();
    await master.transaction(async () => {
      await new User().setName(`${name}-tx`).create();
      check(await new User().connect(master).name(`${name}-tx`).getCount() === 1, 'the primary connection inside its transaction');
      check(await new User().connect(slave1).name(`${name}-tx`).getCount() === 0, 'the replica connection reads no uncommitted row');
    });
    await awaitReplica(dialect, primary, replica);
    check(await new User().connect(slave1).name([`${name}-renamed`, `${name}-tx`]).getCount() === 2, 'the replica reads the committed rows');
  } finally {
    await master.close();
    if (slave1) await slave1.close();
  }
}

/** A connection to a SQLite database file that the process may only read: reads succeed, and a write returns READ_ONLY. */
async function readOnly(database) {
  await install(database.dsn);
  const writable = await connect(database.dsn);
  try { await new User().connect(writable).setName('read-only').create(); } finally { await writable.close(); }
  await chmod(database.path, 0o444);
  const only = await connect(database.dsn);
  try {
    check(await new User().connect(only).name('read-only').getCount() === 1, 'the read-only database reads the row');
    check(await code(new User().connect(only).setName('rejected').create()) === 'READ_ONLY', 'a write to the read-only database');
  } finally { await only.close(); }
}

function finish(name, before) {
  if (failures > before) throw new Error(`${failures - before} check(s) failed in ${name}; each FAIL line above names one`);
}

for (const dialect of ['mysql', 'postgres']) {
  caseTest(`replica/primary_and_replica/${dialect}`, DATABASE, async ({ step }) => {
    const before = failures;
    current = `primary_and_replica/${dialect}`;
    const variable = `ORM_TEST_${dialect.toUpperCase()}_REPLICA_DSN`;
    const replica = process.env[variable];
    if (!replica) throw new Error(`${variable} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers`);
    // The replica DSN points to the same name as the case database. The replica replicates the primary's CREATE
    // DATABASE, and primaryAndReplica waits for the replica to catch up before connecting to it.
    await withCaseDatabase(dialect, step, database =>
      primaryAndReplica(dialect, database.dsn, relatedDsn(replica, new URL(database.dsn).pathname.slice(1))));
    finish(current, before);
  });
}
caseTest('replica/read_only/sqlite', DATABASE, async ({ step }) => {
  const before = failures;
  current = 'read_only/sqlite';
  await withCaseDatabase('sqlite', step, database => readOnly(database));
  finish(current, before);
});
