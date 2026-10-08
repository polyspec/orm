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
// Usage: node packages/orm-npm/tests/idle-connection-end.mjs [child <dialect> <dsn>]
import { spawnSync } from 'node:child_process';
import { connect } from '../dist/index.js';
import { DATABASE, sections } from '../../../tests/testcase.mjs';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';

/**
 * Ends every session of database name on the server, except the one that ends
 * them, and returns when the server has closed them. pg_terminate_backend waits
 * for the backend to exit; KILL returns before the thread closes its socket, so
 * the MySQL branch waits until PROCESSLIST no longer lists the ended sessions.
 */
async function endSessions(dialect, adminDsn, name) {
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
    for (const { id } of rows) await connection.query(`KILL ${Number(id)}`);
    const ids = rows.map(({ id }) => Number(id));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [left] = await connection.query('SELECT ID AS id FROM information_schema.PROCESSLIST WHERE ID IN (?)', [ids.length ? ids : [0]]);
      if (left.length === 0) break;
      if (Date.now() > deadline) throw new Error(`the server still lists sessions ${left.map(({ id }) => id).join(', ')} 10 s after KILL`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return rows.length;
  } finally { await connection.end(); }
}

if (process.argv[2] === 'child') {
  const [, , , dialect, dsn] = process.argv;
  const admin = dialect === 'postgres' ? process.env.ORM_TEST_POSTGRES_DSN : process.env.ORM_TEST_MYSQL_DSN;
  const name = new URL(dsn).pathname.slice(1);
  const db = await connect(dsn);
  await db.utils().schema().empty();
  const ended = await endSessions(dialect, admin, name);
  if (ended !== 1) throw new Error(`ended ${ended} sessions of ${name}, want the one idle pooled connection`);
  // The server has closed the socket; one turn of the event loop delivers that
  // end to the pool before the next statement asks it for a connection.
  await new Promise(resolve => setImmediate(resolve));
  // The next statement runs on a connection that the server did not end.
  await db.utils().schema().empty();
  await db.close();
  console.log(`child: the pool survived the end of its idle connection on ${dialect}`);
} else {
  const log = sections();
  let failed = 0;
  for (const dialect of ['postgres', 'mysql']) {
    log.begin(`idle-connection-end/${dialect}`, DATABASE);
    try {
      await withCaseDatabase(dialect, text => log.step(text), async database => {
        const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, 'child', dialect, database.dsn], { encoding: 'utf8', env: process.env, timeout: DATABASE });
        for (const line of `${child.stdout}${child.stderr}`.split('\n').filter(Boolean)) log.step(line);
        if (child.status !== 0) throw new Error(`the child process ended with ${child.status}`);
      });
      log.end();
    } catch (error) {
      failed++;
      log.end(error.message);
    }
  }
  if (failed) process.exitCode = 1;
}
