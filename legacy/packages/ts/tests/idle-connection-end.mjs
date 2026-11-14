// A pooled connection that the server ends while it is idle must not end the
// calling process. A child process connects to a new case database, runs a
// statement so that the pool keeps one idle connection, has the server end that
// connection (pg_terminate_backend on PostgreSQL, KILL on MySQL), runs a statement
// again, closes the handle and exits. The case requires exit 0 and no unhandled
// error event: the server's message on the idle connection reaches the pool, and
// a pool without a listener for it throws "Unhandled 'error' event".
//
// The child also covers the closing race of a schema test case: when the handle
// closes and the case database is dropped WITH (FORCE) at once, the server ends a
// connection that the pool is still closing.
//
// Usage: node packages/ts/tests/idle-connection-end.mjs [child <dialect> <dsn>]
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from '../dist/index.js';
import { caseTest } from '../../../../tests/testcase.mts';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';

/**
 * Ends every session of database name on the server, except the one that ends them, and returns when the server has
 * closed them; the limit of each wait is the server's and the event is its answer (T475). pg_terminate_backend(pid, 5000)
 * answers when the backend has exited, within a bound that the server applies. KILL returns before the killed thread has
 * ended, so on MySQL and MariaDB the idle connection holds the named lock `lock` (holdLock): GET_LOCK of that lock with a
 * wait of 30 s, a limit of the server, returns 1 when the killed thread has ended and released it.
 */
async function endSessions(dialect, adminDsn, name, lock) {
  if (dialect === 'postgres') {
    const client = postgresClient(adminDsn);
    await client.connect();
    try {
      const { rows } = await client.query('SELECT pg_terminate_backend(pid, 5000) AS ended FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      return rows.length;
    } finally { await client.end(); }
  }
  const connection = await mysqlConnection(adminDsn, null);
  try {
    const [rows] = await connection.query('SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()', [name]);
    if (rows.length !== 1) return rows.length;
    const id = Number(rows[0].id);
    // One read: the idle connection holds the lock unless the pool reset its session when it took it back.
    const [[{ holder }]] = await connection.query('SELECT IS_USED_LOCK(?) AS holder', [lock]);
    if (Number(holder) !== id) throw new Error(`the idle connection ${id} does not hold the named lock ${lock}: IS_USED_LOCK is ${holder}, so the pool reset its session when it took it back`);
    await connection.query(`KILL ${id}`);
    const [[{ taken }]] = await connection.query('SELECT GET_LOCK(?, 30) AS taken', [lock]);
    if (Number(taken) !== 1) throw new Error(`GET_LOCK(${lock}, 30) returned ${taken}: the killed thread ${id} did not end within the limit of the server`);
    await connection.query('SELECT RELEASE_LOCK(?)', [lock]);
    return 1;
  } finally { await connection.end(); }
}

/**
 * Makes the idle connection of the pool of db hold the named lock `lock` on MySQL and MariaDB: execute runs `DO GET_LOCK`
 * on a connection of the pool, which then returns to the pool idle (INT-76).
 */
async function holdLock(db, lock) {
  await db.execute({ id: 0, role: 'write', sql: `DO GET_LOCK('${lock}', 0)`, tables: [], bind_slots: [] }, []);
}

if (process.argv[2] === 'child') {
  const [, , , dialect, dsn] = process.argv;
  const admin = dialect === 'postgres' ? process.env.ORM_TEST_POSTGRES_DSN : process.env.ORM_TEST_MYSQL_DSN;
  const name = new URL(dsn).pathname.slice(1);
  const db = await connect(dsn);
  await db.utils().schema().empty();
  const lock = `orm_int92_${randomUUID()}`;
  if (dialect !== 'postgres') await holdLock(db, lock);
  const ended = await endSessions(dialect, admin, name, lock);
  if (ended !== 1) throw new Error(`ended ${ended} sessions of ${name}, want the one idle pooled connection`);
  // The server has closed the socket; one turn of the event loop delivers that
  // end to the pool before the next statement asks it for a connection.
  await new Promise(resolve => setImmediate(resolve));
  // The next statement runs on a connection that the server did not end.
  await db.utils().schema().empty();
  await db.close();
  console.log(`child: the pool survived the end of its idle connection on ${dialect}`);
} else {
  for (const dialect of ['postgres', 'mysql']) {
    // INT-92: a connection that the server ends while the pool holds it idle is discarded, and the process keeps running.
    caseTest(`idle-connection-end/${dialect}`, async ({ step }) => {
      await withCaseDatabase(dialect, step, async database => {
        const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child', dialect, database.dsn], { encoding: 'utf8', env: process.env });
        for (const line of `${child.stdout}${child.stderr}`.split('\n').filter(Boolean)) step(line);
        if (child.status !== 0) throw new Error(`the child process ended with ${child.status}`);
      });
    });
  }
}
