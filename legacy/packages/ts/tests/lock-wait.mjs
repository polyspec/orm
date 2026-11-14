// The PostgreSQL events that order a step of a test after a lock wait or after the start of a client statement (T475). A
// test that read the lock tables on an interval, or waited on a timer, would depend on the load of the machine.
import { mysqlConnection, postgresClient } from './case-database.mjs';

/**
 * Makes the PostgreSQL session of client report its lock waits, and returns a function that returns a promise of the next
 * one. With deadlock_timeout 1 ms, log_lock_waits on and client_min_messages log, the server sends the session the LOG
 * message "process <pid> still waiting for <lock> ..." once its statement has waited 1 ms for a lock, while the statement
 * still waits. The promise is taken before the statement starts, so that the message cannot pass unseen.
 */
export async function reportLockWaits(client) {
  await client.query("SET deadlock_timeout = '1ms'");
  await client.query('SET log_lock_waits = on');
  await client.query('SET client_min_messages = log');
  return () => new Promise(resolve => {
    const seen = notice => {
      if (!/still waiting for/.test(notice.message)) return;
      client.off('notice', seen);
      resolve();
    };
    client.on('notice', seen);
  });
}

let installed = 0;

/**
 * Reports the start of an UPDATE of table on PostgreSQL. A client statement runs on a session of the client, which receives
 * no message that the test reads, so a statement trigger of table cancels a session of the test that waits for an advisory
 * lock that another session of the test holds: the error of that session (57014) reports that the statement has started on
 * the server, before it takes a row lock. The trigger is installed before any session holds rows of table, because
 * CREATE TRIGGER waits for them; it cancels nothing until arm() names the waiting session, so an earlier UPDATE, such as the
 * one of a holder, does not count. arm() resolves when that session waits, with the promise of the start; close() removes
 * the trigger and ends the sessions after the holder has released the rows.
 */
export async function statementStarts(dsn, table) {
  const name = `orm_test_started_${process.pid}_${installed++}`;
  const owner = postgresClient(dsn);
  const waiter = postgresClient(dsn);
  await owner.connect();
  await waiter.connect();
  await owner.query(`CREATE TABLE "${name}" (pid integer NOT NULL)`);
  await owner.query(`CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_cancel_backend(pid) FROM "${name}"; RETURN NULL; END $$`);
  await owner.query(`CREATE TRIGGER "${name}" BEFORE UPDATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION "${name}"()`);
  const nextWait = await reportLockWaits(waiter);
  return {
    async arm() {
      await owner.query('SELECT pg_advisory_lock(hashtext($1))', [name]);
      const { rows: [{ pid }] } = await waiter.query('SELECT pg_backend_pid() AS pid');
      const waits = nextWait();
      const started = waiter.query('SELECT pg_advisory_lock(hashtext($1))', [name]).then(
        () => { throw new Error(`${name}: the waiting session took the advisory lock, so no statement cancelled it`); },
        error => { if (error.code !== '57014') throw error; },
      );
      await Promise.race([waits, started]);
      await owner.query(`INSERT INTO "${name}" (pid) VALUES ($1)`, [pid]);
      return { started };
    },
    async close() {
      try {
        await owner.query(`DROP TRIGGER "${name}" ON "${table}"`);
        await owner.query(`DROP FUNCTION "${name}"()`);
        await owner.query(`DROP TABLE "${name}"`);
      } finally {
        await Promise.allSettled([owner.end(), waiter.end()]);
      }
    },
  };
}

/**
 * Runs statement, which needs a lock that another session holds, on a MySQL or MariaDB session of the test whose lock waits
 * the server ends after one second by its own setting (lock_wait_timeout, innodb_lock_wait_timeout), and returns when the
 * server ends the wait with 1205. A statement of a client session gives the test no event when it starts to wait for a lock,
 * so a test that aborts such a statement runs this probe after it has handed the statement to the client: the error is the
 * response of the server that the lock is held and that a statement waits for it, and the second of the probe's wait, which
 * the server bounds, lets the statement that started before the probe reach its own wait (T475).
 */
export async function lockWaitEnds(dsn, statement) {
  const connection = await mysqlConnection(dsn);
  try {
    await connection.query('SET SESSION lock_wait_timeout = 1');
    await connection.query('SET SESSION innodb_lock_wait_timeout = 1');
    try {
      await connection.query(statement);
    } catch (error) {
      if (error.errno === 1205) return;
      throw error;
    }
    throw new Error(`${statement} took its lock, so no session held it`);
  } finally { await connection.end(); }
}
